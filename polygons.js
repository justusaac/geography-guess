//using Lambert cylindrical equal-area projection
function project_coords(point){
	//[lng,lat] -> [x,y]
	const x = point[0]
	const y = Math.sin(point[1] * Math.PI / 180)
	return [x,y]
}
function unproject_coords(point){
	//[x,y] -> [lng,lat]
	const lng = point[0]
	const lat = Math.asin(point[1]) * 180 / Math.PI
	return [lng,lat]
}

function get_intersection_x(segment, y){
	if(segment[0][1]>segment[1][1]){
		segment = [segment[1],segment[0]];
	}
	if(y<segment[0][1] || y>segment[1][1]){
		return null;
	}
	const dy = segment[1][1]-segment[0][1]
	const dx = segment[1][0]-segment[0][0]
	const progress = (y-segment[0][1])/dy;
	return progress * dx + segment[0][0];
}
function geojson_polygon_search(geojson){
	if(geojson == null || typeof geojson !== "object"){
		return [];
	}
	if(geojson.type === "MultiPolygon"){
		return geojson.coordinates
	}
	if(geojson.type === "Polygon"){
		return [geojson.coordinates]
	}
	const results = [];
	for(const elem of (Array.isArray(geojson) ? geojson : Object.values(geojson))){
		results.push(...geojson_polygon_search(elem))
	}
	return results
}
//The "rejection sampling" approach is not the fastest/best but generating the maps is so much IO bound that it is ok
function* random_sample_polygon(coords){
	if(!Array.isArray(coords)){
		yield* random_sample_polygon(geojson_polygon_search(coords));
	}
	//coords = geojson multipolygon coordinates format
	const segments = []
	const bounds = {
		max_x:-Infinity,
		min_x:Infinity,
		max_y:-Infinity,
		min_y:Infinity,
	}
	for(const section of coords){
		for(const boundary of section){
			let prev_point = project_coords(boundary[boundary.length-1]);
			for(let i=0; i<boundary.length; i++){
				const cartesian_point = project_coords(boundary[i]);
				segments.push([prev_point, cartesian_point]);
				prev_point = cartesian_point;

				bounds.max_x = Math.max(bounds.max_x, cartesian_point[0])
				bounds.min_x = Math.min(bounds.min_x, cartesian_point[0])
				bounds.max_y = Math.max(bounds.max_y, cartesian_point[1])
				bounds.min_y = Math.min(bounds.min_y, cartesian_point[1])
			}
		}
	}
	segments.sort((seg1, seg2) => {
		y1 = Math.min(seg1[0][1], seg1[1][1])
		y2 = Math.min(seg2[0][1], seg2[1][1])
		return y1-y2
	});
	while(true){
		const x = Math.random() * (bounds.max_x-bounds.min_x) + bounds.min_x;
		const y = Math.random() * (bounds.max_y-bounds.min_y) + bounds.min_y;
		let odd_xes_before = false;
		for(const segment of segments){
			if(Math.min(segment[0][1], segment[1][1])>y){
				break;
			}
			const seg_x = get_intersection_x(segment, y)
			if(seg_x != null && seg_x < x){
				odd_xes_before = !odd_xes_before
			}
		}
		if(odd_xes_before){
			yield unproject_coords([x,y]);
		}
	}
}
module.exports = {
	random_sample_polygon
};