
const MapFile = require(__dirname+"/../map_file_storage.js");
const infilename = process.argv[2];
const outfilename = process.argv[3] ?? "./locations.json";
if(!infilename){
	console.log(`usage: node "${__filename}" INPUT_FILE_NAME [OUTPUT_FILE_NAME]`);
	process.exit();
}
;(async ()=>{
const map = await MapFile.open(infilename);
await map.dump(outfilename);
console.log(`dumped to ${outfilename}`);
})();