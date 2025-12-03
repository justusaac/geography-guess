
const MapFile = require(__dirname+"/../map_file_storage.js");
const pg = require('pg');
const path = require('path');
const fs = require('fs');
const infilename = process.argv[2];
if(!infilename){
	console.log(`usage: node "${__filename}" INPUT_FILE_NAME [MAP_NAME]`);
	process.exit();
}
const mapname = process.argv[3] ?? path.basename(infilename).split('.')[0];
;(async ()=>{
const pool = new pg.Pool();
const site_admin_user_id = -1;
let mapid = (await pool.query("select MapID from Maps where UserID=$1::int and MapName=$2::text", [site_admin_user_id, mapname])).rows[0]?.mapid;
if(!mapid){
	mapid = await MapFile.create(mapname, `Imported ${mapname} map`, site_admin_user_id);
}
const map = await MapFile.open(mapid,true);
pool.end();
const readstream = fs.createReadStream(infilename, {encoding:'utf8'});
await map.import(readstream);
console.log(`imported to ${mapname}`);
await map.update_metadata();
await map.close();
})();