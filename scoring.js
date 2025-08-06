const EARTH_RADIUS = 6378.137;
module.exports = {
	score: function (distance, modifier=1){
		if(distance < 25/1000){
			return 5000
		}
		const p = Math.E**(10/(modifier*2*EARTH_RADIUS));
		return Math.round(
			5000/(p**distance)
		);
	},

	great_circle_distance: function (loc1, loc2){
		const lat1 = loc1.lat*Math.PI/180;
		const lat2 = loc2.lat*Math.PI/180;
		const d_lat = Math.abs(lat1-lat2);
		const d_lng = Math.abs(loc1.lng-loc2.lng)*Math.PI/180;
		return 2*EARTH_RADIUS*Math.asin(
			1/Math.sqrt(2)*Math.sqrt(
				1 - Math.cos(d_lat) + Math.cos(lat1) * Math.cos(lat2) * (1 - Math.cos(d_lng))
			)
		);
	},
	EARTH_RADIUS
}
