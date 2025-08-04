require('dotenv').config({path:__dirname+"/../.env"});

const browserrun = require('browser-run');
const MapFile = require(__dirname+"/../map_file_storage.js");
const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const {random_sample_polygon} = require(__dirname+"/../polygons.js");
require('express-ws')(app);
app.use(require('cors')());
app.use(express.json())
;(async ()=>{

let desired_locations = process.argv[2] ?? 1000;

const filename = process.argv[4] ?? __dirname+"/../maps/"+path.basename(process.argv[3] ?? "world").split(".")[0]+".map"
const map = await MapFile.open(filename);

const initial_loc_count = await map.location_count();

const shutdown = async () => {
	console.log("\nShutting down")
    const loc_count = await map.location_count();
    await map.close();
    console.log(`\ndone with ${filename}, now has ${loc_count} locations (added ${loc_count-initial_loc_count})`);


	process.exit()
}
process.on("SIGINT",shutdown)
var total_found_locations = 0;
app.ws("/locationstream", (ws,req) => {
    ws.on('message', (msg) => {
    	if(msg==="SHUTDOWN"){
    		return shutdown()
    	}
    	if(msg==="RESTART"){
    		console.log("\nrestarting browser");
    		return startBrowserSearch(desired_locations-total_found_locations)
    	}
		try{
			map.write_loc(JSON.parse(msg));		
			total_found_locations++
			process.stdout.clearLine();
			process.stdout.cursorTo(0);
			process.stdout.write(`${total_found_locations}/${desired_locations} `)
			process.stdout.write(msg);
		}
		catch{
			console.log("\nError: ")
			console.log(msg)
		}
    })
})
const port_number = 8123

app.listen(port_number, () => {
	console.log(`Going to add ${desired_locations} locations to ${filename}`)
})
const startBrowserSearch = (() => {
	const browsertextparts = [`
	console.log("browser started")
	const get_point = (() => {
		const module = {};
		${fs.readFileSync(__dirname+"/../polygons.js")};
		const poly = ${
			process.argv[3] 
			? (fs.readFileSync(process.argv[3]))
			: JSON.stringify([[[[180,-90],[180,90],[-180,90],[-180,-90],[180,-90]]]])
		} 
		const gen = random_sample_polygon(poly)
		return ()=>{
			[lng,lat] = gen.next().value
			return {lng,lat}
		}
	})();
	window.onMapsLoad = async () => {
		console.log("Maps API loaded")
		const desired_locations = `,`	
		const svs = new google.maps.StreetViewService();
		let completed_locations = 0;
		const socket = new WebSocket("ws://localhost:${port_number}/locationstream");
		while(completed_locations<desired_locations){
			let barrier_resolve;
			const timeoutid = setTimeout(()=>{
				socket.send("RESTART")
				window.close();
			}, 10000);
			const barrier = new Promise((resolve)=>{
				barrier_resolve = resolve
			});

			const remaining = {count:Math.max(50,Math.min(1000, desired_locations-completed_locations))};
			for(let tests = 0; tests<remaining.count; tests++){
				svs.getPanorama({
					location:get_point(),
					radius:333,
					preference:google.maps.StreetViewPreference.NEAREST,
					sources:[google.maps.StreetViewSource.GOOGLE],
				}, (panoData, status)=>{
					if(status===google.maps.StreetViewStatus.OK){
						const gen1 = panoData.tiles.worldSize.width<4000
						if(!gen1){
							const loc = {
								heading: Math.random()*360,
								lat: panoData.location.latLng.lat(),
								lng: panoData.location.latLng.lng(),
							};
							socket.send(JSON.stringify(loc))
							completed_locations++;
						}
					}
					remaining.count--;
					if(remaining.count<=0 || completed_locations>=desired_locations){
						barrier_resolve();
					}
				});
			}
			await barrier;
			clearTimeout(timeoutid);
		}
		socket.send("SHUTDOWN")
		window.close();
	}
	const script = document.createElement('script');
	script.src = "https://maps.googleapis.com/maps/api/js?key=${process.env.MAPS_API_KEY}&callback=onMapsLoad";
	document.head.appendChild(script);
	`]
	return (loc_count) => {
		const browser = browserrun();
		browser.pipe(process.stdout)
		browser.end(browsertextparts.join(loc_count));
	}
})();
startBrowserSearch(desired_locations)

})()