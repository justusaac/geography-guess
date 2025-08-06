require('dotenv').config({path:__dirname+"/../.env"});
const pg = require('pg');
const fs = require('fs');
const path = require('path');
const MapFile = require(__dirname+'/../map_file_storage.js');

const known_maps = {};

const pool = new pg.Pool();

const add_map_to_db = async (mappath) => {
	const name = path.basename(mappath).split(".")[0];
	const title = known_maps[name]?.title || name;
	const desc = known_maps[name]?.description || `Auto-generated map for ${title}`;
	const mf = await MapFile.open(mappath);
	const location_count = await mf.location_count()
	const score_modifier = await mf.score_modifier()
	await mf.close()
	return pool.query(`insert into Maps (MapName, Description, FileName, UserID, LocationCount, ScoreModifier) values ($1, $2, $3, -1, $4, $5) on conflict (FileName) do update set ${['MapName', 'Description', 'UserID', 'LocationCount', 'ScoreModifier'].map(x=>`${x}=excluded.${x}`).join(',')}`, [title, desc, mappath, location_count, score_modifier]);
};

if(require.main === module) {
	(async ()=>{
		const mapdir = path.join(__dirname, "..", "maps");
		const files = await fs.promises.readdir(mapdir);
		for(const file of files){
			if(!file.endsWith(".map")){
				continue;
			}
			const mappath = path.join(mapdir, file);
			await add_map_to_db(mappath);
			console.log(file)
		}
	})();
}

module.exports = {add_map_to_db};