require('dotenv').config({path:__dirname+"/../.env"});
const pg = require('pg');
const fs = require('fs');
const path = require('path');
const MapFile = require(__dirname+'/../map_file_storage.js');

const known_maps = {};

(async ()=>{
	const pool = new pg.Pool();
	const mapdir = path.join(__dirname, "..", "maps");
	const files = await fs.promises.readdir(mapdir);
	for(const file of files){
		const name = file.split(".")[0];
		const title = known_maps[name]?.title || name;
		const desc = known_maps[name]?.description || `Auto-generated map for ${title}`;
		const mappath = path.join(mapdir, file);
		const location_count = await (async () =>{
			const mf = await MapFile.open(mappath)
			const ans = await mf.location_count()
			await mf.close()
			return ans
		})();
		pool.query(`insert into Maps (MapName, Description, FileName, UserID, LocationCount) values ($1, $2, $3, -1, $4) on conflict (FileName) do update set ${['MapName', 'Description', 'UserID', 'LocationCount'].map(x=>`${x}=excluded.${x}`).join(',')}`, [title, desc, mappath, location_count]);
		console.log(file)
	}
})();