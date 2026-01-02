require('dotenv').config({path:__dirname+"/.env"});
const pg = require('pg');
const {LargeObjectManager, LargeObject} = require('pg-large-object');

const PROPERTIES = ["lat","lng","zoom","heading","pitch"];
const BUFFER_SIZE = 8*(PROPERTIES.length);

class MapFile{

	static object_to_buffer(obj){
		const buf = Buffer.alloc(BUFFER_SIZE);
		let offset = 0;
		for(const prop of PROPERTIES){
			if(obj[prop]==undefined && ["lat","lng"].includes(prop)){	
				throw new Error(`missing required location attribute ${prop}`);
			}
			offset = buf.writeDoubleLE(obj[prop] ?? 0, offset);
		}
		return buf;
	}
	static buffer_to_object(buf){
		const output = {}
		let offset = 0;
		for(const prop of PROPERTIES){
			output[prop] = buf.readDoubleLE(offset);
			offset+=8;
		}
		return output;
	}
	static async create(name, description, userid){
		const client = new pg.Client();
		await client.connect();
		await client.query("begin");
		const oid = await (new LargeObjectManager(client)).createAsync();
		const result = await client.query("insert into Maps (MapName, Description, UserID, ObjectID) values ($1::text, $2::text, $3::int, $4::int) returning MapID", [name,description, userid, oid]);
		await client.query("commit");
		client.end();
		return result.rows[0]?.mapid;
	}
	static async open(mapid, write=false){
		const instance = new MapFile();
		instance.client = new pg.Client();
    	await instance.client.connect();
    	await instance.client.query("begin;");
    	const result = await instance.client.query("select * from Maps where MapID=$1::integer", [mapid]);
    	const oid = result.rows[0]?.objectid;
    	if(!oid){
    		await instance.close();
    		return null;
    	}
    	instance.largeobject = await (new LargeObjectManager(instance.client)).openAsync(oid, write ? LargeObjectManager.READWRITE : LargeObjectManager.READ);
    	instance.oid = oid;
    	instance.mapid = mapid;
		return instance;
	}
	static async delete(mapid){
		const client = new pg.Client();
		await client.connect();
		await client.query("begin");
		const lom = new LargeObjectManager(client);
		const result = await client.query("delete from Maps where MapID=$1::integer returning objectid", [mapid]);
		for(const {objectid} of result.rows){
			await lom.unlinkAsync(objectid);
		}
		await client.query("commit");
		client.end();
		return result.rows.length;
	}
	async update_metadata(){
		const score_modifier = await this.score_modifier();
		const location_count = await this.location_count();
		return this.client.query("update Maps set UpdateTime=current_timestamp,ScoreModifier=$1,LocationCount=$2::int where ObjectID=$3::int", [score_modifier, location_count, this.oid])
	}
	async close(){
		if(this.largeobject){
			const lo = this.largeobject;
			this.largeobject = null;
			await lo.closeAsync();
		}
		if(this.client){
			const cl = this.client;
			this.client = null;
			await cl.query("commit;");
			await cl.end();
		}
	}
	async read_loc(idx){
		await this.largeobject.seekAsync(idx * BUFFER_SIZE, LargeObject.SEEK_SET);
		return MapFile.buffer_to_object(
			await this.largeobject.readAsync(BUFFER_SIZE)
		);
	}
	async *read_all_locs(){
		await this.largeobject.seekAsync(0, LargeObject.SEEK_SET);
		for await (let chunk of this.largeobject.getReadableStream(BUFFER_SIZE * 500)){
			while(chunk.length>0){
				yield MapFile.buffer_to_object(chunk);
				chunk = chunk.slice(BUFFER_SIZE);
			}
		}
	}
	async location_count(){
		return (await this.largeobject.sizeAsync()) / BUFFER_SIZE;
	}
	async random_loc(seed){
		seed ??= Math.floor(Math.random()*(2**31));
		const loc_count = await this.location_count();
		const chosen_loc = (new LCGenerator(seed).next())%loc_count;
		return this.read_loc(chosen_loc);
	}
	async random_locs(n,seed){
		seed ??= Math.floor(Math.random()*(2**31));
		const gen = new LCGenerator(seed);
		const loc_count = await this.location_count();
		if(n>loc_count){
			throw new Error(`Not enough locations (${n}>${loc_count})`);
		}
		if(n==loc_count){
			//If the map has exactly enough locations, present them in order (not randomly)
			return this.to_object()
		}
		const output = [];
		const chosen_indices = [];
		while(output.length<n){
			let chosen_loc = gen.next() % (loc_count-output.length);
			for(let i=0; i<=chosen_indices.length; i++){
				if(chosen_loc>=chosen_indices[i]){
					chosen_loc++;
				}
				else{
					chosen_indices.splice(i, 0, chosen_loc);
					break;
				}
			}
			output.push(await this.read_loc(chosen_loc));
		}
		return output;
	}
	async write_loc(loc){
		await this.largeobject.seekAsync(0, LargeObject.SEEK_END);
		return this.largeobject.writeAsync(MapFile.object_to_buffer(loc));
	}
	async write_locs(locs){
		await this.largeobject.seekAsync(0, LargeObject.SEEK_END);
		return new Promise(async (resolve, reject)=>{
			const writestream = this.largeobject.getWritableStream(BUFFER_SIZE * 500);
			for await (const loc of locs){
				writestream.write(MapFile.object_to_buffer(loc));
			}
			writestream.end(resolve);
		});
	}

	async clear(){
		return this.largeobject.truncateAsync(0);
	}


	async filter(predicate){
		await this.largeobject.seekAsync(0, LargeObject.SEEK_SET);
		let i=0;
		let kept=0;
		await new Promise(async (resolve,reject)=>{
			const writestream = this.largeobject.getWritableStream(BUFFER_SIZE * 500);
			for await (const loc of this.read_all_locs()){
				if(predicate(loc,i)){
					const pos = await this.largeobject.tellAsync();
					this.largeobject.seekAsync(kept*BUFFER_SIZE, LargeObject.SEEK_SET);
					writestream.write(MapFile.object_to_buffer(loc));
					this.largeobject.seekAsync(pos, LargeObject.SEEK_SET);
					kept++;
				}
				i++;
			}
			writestream.end(resolve);
		});
		return this.largeobject.truncateAsync(kept*BUFFER_SIZE);
	}

	async score_modifier(){
		const new_bounds = ()=> {return {min:Infinity, max:-Infinity}};
		const add_to_bounds = (bounds, val) => {
			bounds.min = Math.min(bounds.min, val);
			bounds.max = Math.max(bounds.max, val);
		}
		const lat_bounds = new_bounds();
		const lng_quadrants = Array(4).fill().map(()=>false);
		const lng_bounds_skipped_quadrants = Array(lng_quadrants.length).fill().map(new_bounds);
		for await(const loc of this.read_all_locs()){
			const quadrant = Math.floor(((loc.lng+180)%360)/90);
			lng_quadrants[quadrant] = true;
			add_to_bounds(lat_bounds, loc.lat);
			let found = false;
			for(let skip=0; skip<lng_quadrants.length; skip++){
				if(lng_quadrants[skip]){
					continue;
				}
				found = true;
				const lhs = skip*90 - 180;
				const adjusted_lng = loc.lng + 360*(loc.lng<lhs);
				add_to_bounds(lng_bounds_skipped_quadrants[skip], adjusted_lng);
			}
			if(!found){
				return 1;
			}
		}
		const lat_range = lat_bounds.max-lat_bounds.min;
		if(lat_range>90 || lat_range<0){
			return 1;
		}
		let lng_range = 180;
		for(let i=0; i<lng_quadrants.length; i++){
			if(lng_quadrants[i]){
				continue;
			}
			const bounds = lng_bounds_skipped_quadrants[i]
			lng_range = Math.min(lng_range, bounds.max-bounds.min);
		}
		if(lat_range==0 && lng_range==0){
			return 1;
		}
		return Math.max(lng_range/180, lat_range/90);
	}

	async to_object(){
		const output = [];
		for await(const loc of this.read_all_locs()){
			output.push(loc);
		}
		return output;
	}
	async dump(outstream){
		outstream.write("[")
		let comma = false;
		for await(const loc of this.read_all_locs()){
			if(comma){
				outstream.write(",")
			}
			else{
				comma=true;
			}
			outstream.write(JSON.stringify(loc))
		}
		outstream.write("]")
	}
	async import(readstream){
		await this.largeobject.seekAsync(0, LargeObject.SEEK_END);
		const writestream = this.largeobject.getWritableStream(BUFFER_SIZE * 500);
		let charbuf = '';
		let object_nest_depth = 0;
		let string_starter = null;
		let escape = false;
		let inside_array = false;
		readstream.on('data',(chunk)=>{
			let objstartidx = 0;
			for(let i=0; i<chunk.length; i++){
				if(escape){
					escape = false;
					continue;
				}
				const char = chunk[i];
				if(string_starter==null){
					if(char=='{' && inside_array){
						if(object_nest_depth++==0){
							objstartidx=i;
						}
					}
					else if(char=='}' && inside_array){
						if(--object_nest_depth==0){
							const obj_str = charbuf + chunk.slice(objstartidx,i+1);
							charbuf = ''
							const loc = JSON.parse(obj_str);
							writestream.write(MapFile.object_to_buffer(loc));
						}
					}
					else if(char=='"' || char=="'"){
						string_starter = char;
					}
					else if(char=='[' && !inside_array){
						object_nest_depth=0;
						inside_array=true;
					}
					else if(char==']' && inside_array && object_nest_depth==0){
						inside_array = false
					}
				}
				else{
					if(char=='\\'){
						escape = true;
					}
					else if(char==string_starter){
						string_starter=null;
					}
				}
			}
			if(object_nest_depth>0){
				charbuf += chunk.slice(objstartidx)
			}
		})
		return new Promise((resolve)=>{
			readstream.on('end',async ()=>{
				await new Promise(r=>{
					writestream.end(r);
				})
				resolve()
			})
		})
	}
}

class LCGenerator{
	constructor(seed){
		this.state = seed;
	}
	next(){
		this.state = ((48271 * this.state) + 0) % (2**31-1);
		return this.state;
	}
}

module.exports = MapFile;