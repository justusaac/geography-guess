const fs = require('fs');
const MapFile = require(__dirname+"/../map_file_storage.js");
const mapid = process.argv[2];
const outfilename = process.argv[3] ?? "./locations.json";
if(!mapid){
	console.log(`usage: node "${__filename}" MAP_ID [OUTPUT_FILE_NAME]`);
	process.exit();
}
;(async ()=>{
const map = await MapFile.open(mapid);
const outfp = await fs.promises.open(outfilename, 'w');
const stream = outfp.createWriteStream({flush:true});
await map.dump(stream);
console.log(`dumped to ${outfilename}`);
map.close();
outfp.close()
})();