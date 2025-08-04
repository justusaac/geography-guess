const fs = require('fs');
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

	static async open(filename){
		const instance = new MapFile();
		instance.fp = await fs.promises.open(filename, 'a+');
		instance.writeStream = instance.fp.createWriteStream({encoding:'binary', start:(await instance.fp.stat()).size, flush:true});
		return instance;
	}
	async read_loc(idx){
		return MapFile.buffer_to_object(
			(await this.fp.read({buffer: Buffer.alloc(BUFFER_SIZE), position: idx*BUFFER_SIZE, length: BUFFER_SIZE})).buffer
		);
	}
	async location_count(){
		return (await this.fp.stat()).size / BUFFER_SIZE;
	}
	async random_loc(){
		const loc_count = await this.location_count();
		const chosen_loc = Math.floor(Math.random() * loc_count);
		return this.read_loc(chosen_loc);
	}
	async random_locs(n){
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
			let chosen_loc = Math.floor(Math.random() * (loc_count-output.length));
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
		return new Promise(resolve =>
			this.writeStream.write(MapFile.object_to_buffer(loc), resolve)
		);
	}
	async write_locs(locs){
		for(let i=0; i<locs.length; i++){
			if(i+1==locs.length){
				return this.write_loc(locs[i]);
			}
			else{
				this.write_loc(locs[i]);
			}
		}
	}

	async close(){
		await this.fp.close();
		this.fp = null;
		this.writeStream = null;
	}
	async to_object(){
		const output = [];
		for(let i=0; i<loc_count; i++){
			output.push(await this.read_loc(i));
		}
		return output;
	}
	async dump(outfile="./locations.json"){
		const outfp = await fs.promises.open(outfile, 'w');
		const stream = outfp.createWriteStream({flush:true});
		const count = await this.location_count();
		stream.write("[")
		for(let i=0; i<count; i++){
			const loc = JSON.stringify(await this.read_loc(i))
			stream.write(loc)
			if(i+1<count){
				stream.write(",")
			}
		}
		stream.write("]")
		outfp.close()
	}
}

module.exports = MapFile;