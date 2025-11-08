class MysteryPano{
	constructor(rootElem, socketURL){
		this.root = rootElem;
		this.socket = new WebSocket(socketURL);
		
		const mapElem = document.createElement('div');
		mapElem.style.width="100%";
		mapElem.style.height="100%";
		this.map = new google.maps.Map(
			mapElem, 
			{
				cameraControl:false,
				clickableIcons:false,
				fullscreenControl:false,
				streetViewControl:false,
				scaleControl:true,
				mapId:"Stunna boy get em real hollywood star"
			}
		);
		this.map.decor = [];
		this.adjust_expanded_map(true);
		this.socket.addEventListener("close", ()=>this.show_error("Websocket connection lost"));
		this.socket.addEventListener("message", msg => {
			//console.log(msg.data)
			const data = JSON.parse(msg.data);
			({
				round:()=>{
					this.show_pano(data);
				},
				round_results:()=>{
					this.show_round_results(data);
				},
				game_results:()=>{
					this.show_game_results(data);
				},
				game_info:()=>{
					this.game_info = data;
					this.pano?.setOptions(this.get_pano_control_options());
				},
				error:()=>{
					console.error(data.message);
					this.show_error(data.message);
				},
			}[data.type]());
		})


		const handlers = [
			["compass",this.set_pov.bind(this, 0)],
			["reset-pos-btn",this.reset_pos.bind(this)],
			["size-button increase",this.adjust_expanded_map.bind(this, true)],
			["size-button decrease",this.adjust_expanded_map.bind(this, false)],
			["breadcrumb-start-btn",this.place_breadcrumbs.bind(this)],
			["breadcrumb-return-btn",this.follow_breadcrumbs.bind(this)],
			["step-back-btn",this.step_back.bind(this)],
			["close-error",this.hide_error.bind(this)]
		]
		for(const [classname, fn] of handlers){
			for(const btn of this.root.getElementsByClassName(classname)){
				btn.onclick = fn;
			}
		}
		for(const map of this.root.getElementsByClassName('button-and-map')){
			for(const btn of map.getElementsByClassName("mobile-map-expander")){
				btn.addEventListener('click', (event) => {
					map.classList.add('expanded');
					event.preventDefault();
				}, true);
			}
			map.onpointerenter = (e) => {
				if(e.pointerType=="mouse"){
					map.classList.add('expanded')
				}
			};
			map.onpointerleave = (e) => {
				if(e.pointerType=="mouse"){
					map.classList.remove('expanded')
				}
			}
		}
		for(const btn of this.root.getElementsByClassName("pano-container")){
			btn.addEventListener('pointerdown',(event) => {
				for(const map of this.root.getElementsByClassName('button-and-map')){
					if(map.contains(event.target)){
						return;
					}
					map.classList.remove('expanded');
					//Finish transitions immediately
					for(const elem of [map,...map.getElementsByClassName('size-button-holder')]){
						const cs = getComputedStyle(elem);
						const original_transitionDelay = elem.style["transition-delay"];
						const original_transitionDuration = elem.style["transition-duration"];
						elem.style["transition-delay"]="0s";
						elem.style["transition-duration"]="0s";
						const original_styles = {}
						for(const property of cs.transitionProperty.split(', ')){
							original_styles[property] = elem.style[property]
							elem.style[property]="initial";
						}
						elem.offsetHeight;
						for(const [property,value] of Object.entries(original_styles)){
							elem.style[property] = value;
						}
						elem.offsetHeight;
						elem.style.removeProperty("transition-delay");
						elem.style.removeProperty("transition-duration");
						elem.style["transition-delay"]=original_transitionDelay;
						elem.style["transition-duration"]=original_transitionDuration;
					}
				}

			},{capture:true})
		}
		const panodiv = this.root.querySelector('.pano-container-real')
		for(const event_type of ['mousedown','touchstart','pointerdown']){
			panodiv.addEventListener(event_type, (event) => {
				if(!this.game_info?.rules.panning){
					event.stopPropagation();
				}
			}, {capture:true});
		}
		panodiv.addEventListener('keydown', (event) => {
			if(!(this.game_info?.rules.moving && this.game_info?.rules.panning)){
				event.stopPropagation();
			}
		}, {capture:true});
	}
	switch_view(view_class){
		for(const elem of this.root.children){
			elem.classList[elem.classList.contains(view_class) ? "remove" : "add"]("hidden");
		}
		this.clear_map();
		google.maps.event.clearListeners(this.map, "click");
	}
	add_to_map(item){
		if(!Object.is(item.getMap ? item.getMap() : item.map, this.map)){
			if(item.setMap){
				item.setMap(this.map);
			}
			else{
				item.map = this.map;
			}
			this.map.decor.push(item);
		}
	}
	clear_map(){
		while(this.map.decor.length){
			this.map.decor.pop().setMap(null);
		}
	}
	get_pano_control_options(){
		return this.game_info ? {
			clickToGo: this.game_info.rules.moving,
			linksControl: this.game_info.rules.moving,
			zoomControl: this.game_info.rules.zooming,
			scrollwheel: this.game_info.rules.zooming,
		} : {};
	}
	show_pano(round_data){
		this.switch_view('pano-container');
		this.location = round_data.location;
		this.round = round_data.round;
		if(this.pano){
			google.maps.event.clearListeners(this.pano, "pano_changed");
			google.maps.event.clearListeners(this.pano, "position_changed");
		}
		this.movement_history = [];
		this.movement_history_with_pop = [];
		//this.pano=null;
		if(!this.pano){
			this.pano = new google.maps.StreetViewPanorama(
				this.root.querySelector('.pano-container-real'),
				{
					visible:true,
					motionTracking:false,
					showRoadLabels:false,
					disableDefaultUI:true,
					linksControl:true,
					zoomControl:true,
					zoomControlOptions:{position:google.maps.ControlPosition.TOP_RIGHT},
					...this.get_pano_control_options()
				}
			);
			this.pano.registerPanoProvider((id)=>{
				if(id != "NOPANO"){
					return null;
				}
				return {
					tiles:{
						centerHeading:0,
						tileSize:{width:100,height:100},
						worldSize:{width:100,height:100},
						getTileUrl:(panoid,tz,tx,ty)=>{
							return null;
						}
					}
				};
			},{cors:true});
			google.maps.event.addListener(this.pano, "pov_changed", this.pov_changed.bind(this));
			
		}
		this.pano.setVisible(true);
		//In the pano_changed event the position will not be updated yet
		//However if the original location is slightly off the shown pano the position_changed event will fire twice for the same pano with different positions
		//The workaround is to only listen for position_changed events happening right after pano_changed events
		google.maps.event.addListener(this.pano, "pano_changed", ()=>{
			google.maps.event.addListenerOnce(this.pano, "position_changed", this.position_changed.bind(this))
		});
		this.reset_pos()
		for(const btn of this.root.getElementsByClassName("breadcrumb-return-btn")){
			btn.disabled = true
		}
		this.breadcrumb = null
		for(const classname of ["breadcrumb-start-btn","breadcrumb-return-btn","step-back-btn","reset-pos-btn"]){
			for(const elem of this.root.getElementsByClassName(classname)){
				elem.style.visibility = this.game_info.rules.moving ? "visible" : "collapse";
			}
		}
		for(const container of this.root.getElementsByClassName("map-container")){
			container.appendChild(this.map.getDiv());
			this.map.fitBounds(google.maps.LatLngBounds.MAX_BOUNDS);
		}
		for(const btn of this.root.getElementsByClassName("lock-in-button")){
			btn.onclick = (()=>{
				if(this.marker){
					this.socket.send(JSON.stringify({
						type:"confirm_guess",
						location:{lat:this.marker.position.lat, lng:this.marker.position.lng},
						round:this.round,
					}));
				}
				google.maps.event.clearListeners(this.map, "click");
			}).bind(this);
			btn.disabled = true;

		}
		for(const container of this.root.getElementsByClassName("score-container")){
			container.textContent = round_data.score_so_far;
		}
		for(const container of this.root.getElementsByClassName("round-container")){
			container.textContent = round_data.round+1;
		}
		for(const container of this.root.getElementsByClassName("mapname-container")){
			container.textContent = this.game_info?.mapname
		}

		google.maps.event.addListener(this.map, "click", (e)=>{
			this.marker ??= new google.maps.marker.AdvancedMarkerElement();
			this.add_to_map(this.marker);
			this.marker.position = e.latLng;

			this.socket.send(JSON.stringify({
				type:"update_guess",
				round:this.round,
				location:{lat:e.latLng.lat(), lng:e.latLng.lng()}
			}));

			for(const btn of this.root.getElementsByClassName("lock-in-button")){
				btn.disabled = false;
			}
		});
		if(this.game_info.rules.time_limit){
			this.set_timer(round_data.start_time, this.game_info.rules.time_limit)
		}
		else{
			for(const el of this.root.getElementsByClassName("round-timer")){
				clearInterval(el.timer_interval);
				el.classList.add("hidden");
			}
		}

	}
	set_timer(start_time, duration){
		for(const el of this.root.getElementsByClassName("round-timer")){
			const now = Date.now()
			const curr_progress = (now-start_time)/duration;
			el.classList.remove("hidden");
			el.style.setProperty('--timer-duration','0s');
			el.style.setProperty('--timer-progress',`${curr_progress}`);
			clearInterval(el.timer_interval);
			const update_timer_msg = ()=>{
				const time_left = duration-(Date.now()-start_time)
				if(time_left<0){
					clearInterval(el.timer_interval);
					//timer_reminder has no special meaning but any message will trigger the server to check the time limit
					this.socket.send(JSON.stringify({type:"timer_reminder"}))
					return;
				}
				el.style.setProperty('--timer-message', '"'+MysteryPano.format_time(time_left,duration)+'"');
			}
			el.timer_interval = setInterval(update_timer_msg, 100);
			update_timer_msg();
			el.offsetHeight;
			el.style.setProperty('--timer-duration',`${duration-(now-start_time)}ms`);
			el.style.setProperty('--timer-progress','1');
		}
	}
	step_back(){
		if(this.movement_history_with_pop?.length>=2){
			this.movement_history_with_pop.pop();
			const new_pos = this.movement_history_with_pop.pop();
			const position = {lat:this.pano.position.lat(), lng:this.pano.position.lng()};
			this.pano.setPosition(new_pos);
		}
	}
	pov_changed(){
		for(const el of this.root.getElementsByClassName("compass")){
			el.style.rotate = -this.pano.pov.heading+'deg';
		}
	}
	position_changed(){
		const position = {lat:this.pano.position.lat(), lng:this.pano.position.lng()};
		for(const history of [this.movement_history_with_pop, this.movement_history]){
			if(position.lat!=history[history.length-1]?.lat || position.lng!=history[history.length-1]?.lng){
				history.push(position);
			}
		}
		for(const btn of this.root.getElementsByClassName('step-back-btn')){
			btn.disabled = this.movement_history_with_pop?.length<2;
		}
	}
	set_pov(heading){
		if(this.game_info?.rules.panning){
			this.pano.setPov({...this.pano.getPov(), heading})
		}
	}
	reset_pos(){
		this.pano.setPosition(this.location);
		this.pano.setZoom(this.location.zoom);
		this.pano.setPov({heading:this.location.heading, pitch:this.location.pitch});

	}
	place_breadcrumbs(){
		this.breadcrumb = this.pano.getPosition();
		for(const btn of this.root.getElementsByClassName("breadcrumb-return-btn")){
			btn.disabled = false
		}
	}
	follow_breadcrumbs(){
		if(this.breadcrumb){
			this.pano.setPosition(this.breadcrumb);
		}
	}
	adjust_expanded_map(increase){
		const heights = [50, 80, 90];
		const widths = [40, 60, 80];
		for(const target of this.root.getElementsByClassName('button-and-map')){
			const original_height = parseInt(target.style.getPropertyValue('--expanded-height') || heights[0]);
			for(let i=(increase ? 0 : heights.length-1); i>=0 && i<heights.length; i+=(increase ? 1 : -1)){
				const height_val = heights[i];
				if((increase && height_val>original_height) || (!increase && height_val<original_height)){
					target.style.setProperty('--expanded-height', heights[i]+'%');
					target.style.setProperty('--expanded-width', widths[i]+'%');
					break;
				}
			}
		}
	}
	show_error(msg){
		for(const elem of this.root.getElementsByClassName("error-popup")){
			elem.classList.remove("hidden");
		}
		for(const elem of this.root.getElementsByClassName("error-message-container")){
			elem.innerHTML = msg;
		}
	}
	hide_error(){
		for(const elem of this.root.getElementsByClassName("error-popup")){
			elem.classList.add("hidden");
		}
	}
	static format_distance(km){
		if(localStorage.getItem("imperial_preference") != "imperial"){
			if(km>=1){
				return `${km.toPrecision(5)} km`;
			}
			else{
				return `${(km*1000).toFixed(0)} m`;
			}
		}
		else{
			const mi = km * 0.62137119;
			if(mi>=1){
				return `${mi.toPrecision(5)} mi`;
			}
			else{
				return `${(mi*5280).toFixed(0)} ft`;
			}
		}
	}
	static format_elapsed(ms){
		const result = []
		let factor = 1000*60*60
		if(ms>=factor){
			result.push(`${Math.floor(ms/factor)}`)
			ms %= factor
		}
		factor /= 60
		if(ms >= factor || result.length > 0){
			result.push(`${Math.floor(ms/factor).toString().padStart(result.length*2,"0")}`)
			ms %= factor
		}
		factor /= 60
		if(!result.length){
			return `${(ms/factor).toPrecision(3)} s`
		}
		result.push(`${Math.floor(ms/factor).toString().padStart(2,"0")}`)
		return result.join(':')
	}
	static get_bounds(loc1, loc2){
		const wrap_idl = Math.abs(loc1.lng - loc2.lng) > 180;
		return {
			north:Math.max(loc1.lat, loc2.lat),
			south:Math.min(loc1.lat, loc2.lat),
			west:Math[wrap_idl ? "max" : "min"](loc1.lng, loc2.lng),
			east:Math[wrap_idl ? "min" : "max"](loc1.lng, loc2.lng),
		}
	}
	static get_color(score){
		return `hsl(${120 * score/5000}, 100%,50%)`;
	}
	static format_time(time, total_time){
		let str = `${Math.floor(time/1000/60).toString().padStart(1,"0")}:${Math.floor((time/1000)%60).toString().padStart(2,"0")}`;
		if(total_time){
			str = str.padStart(MysteryPano.format_time(total_time).length, "0");
		}
		return str;
	}
	static get_color_from_string(str){
		//Numbers carefully manipulated so Team 1, 2, 3 are red, blue, green
		const a = 6676767;
		const c = 6671000;
		const m = 2**31;
		let x = 0;
		for (let i=0; i<str.length; i++){
			x+=str.charCodeAt(i);
		}
		x = (a*x+c)%m;
		//Dodge yellow as it is the correct location markers color
		const hue = x%330 + (x%330>35)*30;
		x = (a*x+c)%m;
		const saturation = 100-x%50;
		x = (a*x+c)%m;
		const lightness = 70-x%40;
		return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
	}
	add_round_to_map(guess, actual, label_guess = '?', label_actual='★', username=null, teamname=null){
		if(!(guess.score==0 && guess.distance==0)){
			const polyline_opts = {
				path:[guess.location, actual],
			    strokeColor: MysteryPano.get_color(guess.score),
			    strokeOpacity: 1,
			    strokeWeight: 2,
			    zIndex:3,
			    geodesic:true,
			    icons:[{icon:{path:google.maps.SymbolPath.FORWARD_CLOSED_ARROW,scale:2}}]
			};
			this.add_to_map(new google.maps.Polyline(polyline_opts));
			this.add_to_map(new google.maps.Polyline({
				...polyline_opts,
				strokeWeight:4,
				strokeColor:'#000000',
				zIndex:-1,
				icons:polyline_opts.icons.map(x => {return {...x, icon:{...x.icon, strokeWeight:4}}})
			}));
			this.add_guess_to_map(guess,label_guess,username, teamname);
		}
		else{
			this.map.panTo(actual);
			this.map.setZoom(6);
		}
		this.add_location_to_map(actual, label_actual);
	}
	add_guess_to_map(guess, label_guess= '?', username=null, teamname=null){
		const question_element = new google.maps.marker.PinElement({
			background: teamname ? MysteryPano.get_color_from_string(teamname) : username ? MysteryPano.get_color_from_string(username) : undefined,
			glyphText:label_guess,
			glyphColor:'white',
		}).element;
		if(username){
			question_element.title = username;
			question_element.style.setProperty("--username", '"'+username+'"');
			question_element.classList.add("username-pin");
		}
		this.add_to_map(new google.maps.marker.AdvancedMarkerElement({
			position:guess.location,
			content:question_element,
			zIndex:1,
		}));
	}
	add_location_to_map(actual, label_actual='★'){
		const anchor = document.createElement('a');
		anchor.href = `https://www.google.com/maps/@?api=1&map_action=pano`
			+`&viewpoint=${actual.lat}%2C${actual.lng}`
			+`&heading=${actual.heading}`
			+`&pitch=${actual.pitch}`
			+`&fov=${180/(2**actual.zoom)}`
		;
		anchor.target = "_blank"
		anchor.appendChild(new google.maps.marker.PinElement({
			background:'#ffd700',
			glyphText:label_actual,
			glyphColor:'black',
		}).element);
		this.add_to_map(new google.maps.marker.AdvancedMarkerElement({
			position:actual,
			content: anchor,
			zIndex:2
		}));
	}
	show_movement_history(){
		if(this.movement_history?.length > 1){
			this.add_to_map(new google.maps.Polyline({
				path:this.movement_history,
				zIndex:0,
				strokeWeight:1,
				strokeColor:"red",
				icons:[{icon:{path:google.maps.SymbolPath.FORWARD_OPEN_ARROW,scale:1}}]
			}));
		}
	}
	show_round_results(round_info){
		this.pano?.setPano("NOPANO");
		this.switch_view('round-results-container');
		for(const container of this.root.getElementsByClassName("round-results-map-container")){
			container.appendChild(this.map.getDiv());
		}
		const no_guess = round_info.guess.distance==0 && round_info.guess.score==0;
		if(!no_guess){
			this.map.fitBounds(MysteryPano.get_bounds(round_info.guess.location, round_info.actual));
		}
		this.add_round_to_map(round_info.guess, round_info.actual);
		this.show_movement_history();
		for(const elem of this.root.getElementsByClassName("round-results-message")){
			elem.innerHTML =
				`Round ${round_info.round+1} results:<br>
				${round_info.guess.score} point${round_info.guess.score==1 ? '' : 's'}!
				<br>${ 
				no_guess ? 
				`You did not make a guess in time` : 
				`Your guess was ${MysteryPano.format_distance(round_info.guess.distance)} away.`
				}`;
		}
		for(const btn of this.root.getElementsByClassName("next-round-button")){
			btn.onclick = ()=>this.socket.send(JSON.stringify({type:"next_round"}));
			if(round_info.round==4){
				btn.innerHTML = "Results";
			}
		}
	}
	add_results_to_map(guesses, locations, username=null, label_guesses = null, label_locations=null, teamname=null){
		const bounds = {north:-90,south:90,east:-180,west:180};
		let markers = 0;
		for(let i=0; i<locations.length; i++){
			if(!guesses[i]){
				continue;
			}
			this.add_round_to_map(guesses[i], locations[i], label_guesses?.[i], (label_locations?.[i]??(i+1)).toString(), Array.isArray(username) ? username[i] : username, Array.isArray(teamname) ? teamname[i] : teamname);
			const marker_locations = [locations[i]];
			if(guesses[i].score!=0 || guesses[i].distance!=0){
				marker_locations.push(guesses[i].location);
			}
			for(const loc of marker_locations){
				bounds.north = Math.max(bounds.north, loc.lat);
				bounds.south = Math.min(bounds.south, loc.lat);
				bounds.east = Math.max(bounds.east, loc.lng);
				bounds.west = Math.min(bounds.west, loc.lng);
				markers++;
			}
		}
		this.map.fitBounds(bounds);
		if(markers<2){
			this.map.setZoom(6);
		}
	}
	show_game_results(game_info){
		this.switch_view('game-results-container');

		for(const container of this.root.getElementsByClassName("game-results-map-container")){
			container.appendChild(this.map.getDiv());
		}
		const add_text_to_fragment = (txt,frag) => {
			const tmp = document.createElement("template");
			tmp.innerHTML = txt;
			frag.append(tmp.content);
		};
		const all_players = Object.entries(
			Object.keys(game_info.challengers??{}).length>0
			? game_info.challengers 
			: {[game_info.username]: game_info.guesses}
		);
		const showeverything = ()=>{
			const round_count = game_info.locations.length;
			const usernames = all_players.flatMap(x=>Array(round_count).fill(x[0]));
			const rounds = all_players.flatMap(x=>x[1]);
			const locations = rounds.map((x,i)=>game_info.locations[i%round_count]);
			const labels = rounds.map((x,i)=>(i%round_count)+1);
			this.clear_map();
			this.add_results_to_map(rounds, locations, usernames, null, labels);
		};
		for(const container of this.root.getElementsByClassName("game-results-message")){
			const base = new DocumentFragment();

			base.appendChild(document.createTextNode(`${
				this.game_info?.rules.moving ? "Moving"
				: this.game_info?.rules.zooming ? "No moving"
				: "No move/pan/zoom"
			} game`));
			if(this.game_info?.rules.time_limit){
				base.appendChild(document.createTextNode(`, ${
					MysteryPano.format_time(this.game_info?.rules.time_limit)
				} limit`));
			}
			base.appendChild(document.createElement('br'));

			const table = document.createElement('table');
			table.classList.add("game-results-table");
			const header = document.createElement('thead');
			const headerrow = document.createElement('tr');
			add_text_to_fragment('<th>Player</th>', headerrow);
			for(let i=0; i<game_info.locations.length; i++){
				const roundheader = document.createElement('th');
				roundheader.innerHTML = `Round ${i+1}`;
				roundheader.style.cursor = "pointer";
				roundheader.addEventListener('click', ()=>{
					const usernames = all_players.map(x=>x[0]);
					const rounds = all_players.map(x=>x[1][i]);
					const locations = rounds.map(()=>game_info.locations[i]);
					const labels = rounds.map(()=>i+1);
					this.clear_map();
					this.add_results_to_map(rounds, locations, usernames, null, labels);
				});
				headerrow.appendChild(roundheader);
			}
			const allroundheader = document.createElement('th');
			allroundheader.innerHTML = "Total";
			allroundheader.style.cursor = "pointer";
			allroundheader.addEventListener('click', showeverything);
			headerrow.appendChild(allroundheader);
			header.appendChild(headerrow);
			table.appendChild(header);
			for(const [username, guesses] of all_players){
				const row = document.createElement('tr');
				const td = document.createElement('td');
				td.style.backgroundColor = game_info.username==username ? "#fffab0" : "unset";
				td.style.cursor = "pointer";
				td.innerHTML = username;
				td.addEventListener("click", () => {
					this.clear_map();
					this.add_results_to_map(guesses, game_info.locations, username)
				});
				row.appendChild(td);
				let total_score = 0;
				let total_elapsed = 0;
				for(let i=0; i<game_info.locations.length; i++){
					total_score += guesses[i].score;
					total_elapsed += guesses[i].elapsed;
					add_text_to_fragment(`<td>${guesses[i].score} points<br>${MysteryPano.format_distance(guesses[i].distance)}<br>${MysteryPano.format_elapsed(guesses[i].elapsed)}</td>`, row);
				}
				add_text_to_fragment(`<td><b style="border:none;">${total_score} points</b><br>${MysteryPano.format_elapsed(total_elapsed)}</td>`, row);
				table.appendChild(row);
			}
			base.appendChild(table);
			base.appendChild(document.createElement('br'));

			if(!game_info.challengers){
				const show_challengers = document.createElement("button");
				show_challengers.innerHTML = "Show challengers"; 
				show_challengers.addEventListener('click',()=>this.socket.send(JSON.stringify({type:"show_challengers"})));
				base.appendChild(show_challengers);
				base.appendChild(document.createElement('br'));
			}

			add_text_to_fragment(`<button class="game-results-button"><a href="/creategame/${this.game_info.mapid}">Exit</a></button>`, base);

			add_text_to_fragment(`<button class="game-results-button"><a href="/playagain/${MysteryPano.get_game_id()}">Play again</a></button>`, base);

			container.replaceChildren(base);
		}
		showeverything();
	}
	static get_game_id(){
		const path = window.location.pathname.split('/');
		return path[path.length-1];
	}
}