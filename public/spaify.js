'use strict';
/*
The point is to load a new page without losing global variables. (for example not needing to load humongous google maps api on every navigation)
avoid:
-onload (html attribute or js)
-global let/const/class
-ready state
-WS close listener without once
-etc
*/
window.SPAify ??= {}
if(Boolean(window.history.pushState) && Boolean(window.history.replaceState) && Boolean(window.fetch) && Boolean(window.URL) && Boolean(window.Promise)){

	function followHash(url){
		if(url.hash){
			history.replaceState(window.history.state || document.documentElement.outerHTML, '', url.href);
			document.getElementById(url.hash.slice(1))?.scrollIntoView();
		}
	}
	async function navigateToShell(addr, setHistory, fallback){
		//console.log("ADDR:",addr);
		const url = new URL(addr, window.location.origin)
		if(!window.History){
			return fallback();
		}
		//console.log(addr,url);
		if(url.origin != window.location.origin){
			return fallback();
		}
		if(url.pathname===window.location.pathname){
			const any_hash = Boolean(url.hash) || Boolean(window.location.hash);
			if(any_hash){
				const different_hash = url.hash!=window.location.hash
				if(different_hash){
					history.pushState(window.history.state || document.documentElement.outerHTML, '', url.href);
				}
				followHash(url);
				return;
			}
		}
		try{
			const response = await fetch(url, { mode: 'same-origin', priority: 'high' });
			if(response.redirected){
				return navigateToShell(response.url, setHistory, fallback)
			}
			if(!response.ok){
				return fallback();
			}
			if(!response.headers.get('Content-Type').startsWith('text/html')){
				return fallback();
			}

			const contents = await response.text();
			setHistory(contents, url.href);
			setDocument(contents);
			followHash(url);
		}
		catch(e){
			return fallback();
		}
	}
	async function navigateTo(addr){
		return navigateToShell(addr, (contents, href)=>history.pushState(contents, '', href), ()=>window.location.assign(addr));
	}
	async function navigateToReplace(addr){
		return navigateToShell(addr, (contents, href)=>history.replaceState(contents, '', href), ()=>window.location.replace(addr));
	}
	document.addEventListener('DOMContentLoaded',()=>{
		history.replaceState(document.documentElement.outerHTML, '', window.location.href);
	})

	const websocketlist = [];
	if(window.WebSocket){
		class HijackedWebSocket extends WebSocket {
			constructor(...args){
				super(...args);
				websocketlist.push(this);
				/*const id=Date.now()%10000;
				console.log("ws ctor",id);
				for(const event of ['open','close','error']){
					this.addEventListener(event,()=>console.log(event+'listener',id))
				}*/
			}
			close(...args){
				super.close(...args);
				this.dispatchEvent(new Event("close"));
			}
		}
		window.WebSocket = HijackedWebSocket;
	}

	const currentScriptSrc = new URL(document.currentScript.src, window.location.origin).href;
	const abort_event = new EventTarget();
	let enter_request = null
	const setDocument = async (contents) => {
		let enter_request_resolve = null;
		try{
			while(enter_request != null){
				await enter_request;
			}
			enter_request = new Promise((resolve,reject)=>{
				enter_request_resolve=resolve;
			})
			abort_event.dispatchEvent(new CustomEvent('abort'));
			let aborted = false;
			abort_event.addEventListener('abort',()=>{
				aborted = true;
			},{once:true})

			while(websocketlist.length>0){
				websocketlist.pop()?.close?.();
			}
			//dont wanna call existing onloads again
			const load_listeners = [];
			const hijack_event_listeners = (target, events)=>{
				const original_ael = target.addEventListener.bind(target);
				target.addEventListener = (...args)=>{
					if(events.includes(args[0])){
						load_listeners.push(args[1]);
					}
					original_ael(...args);
				}
			}
			hijack_event_listeners(window,['load']);
			hijack_event_listeners(document,['load', 'DOMContentLoaded']);
			//console.log(contents);
			const parser = new DOMParser();
			const new_doc = parser.parseFromString(contents, 'text/html');
			const scripts = [];
			//console.log(new_doc, Array.from(new_doc.scripts));
			for(const script of Array.from(new_doc.scripts)){
				const scriptSrc = new URL(script.src, window.location.origin).href;
				if(scriptSrc==currentScriptSrc){
					continue;
				}
				const newScript = document.createElement('script');
				newScript.innerHTML = script.innerHTML;
				for(const {name,value} of script.attributes){
					if(value){
						newScript[name]=value;
					}
				}
				scripts.push(newScript);
				script.remove();
			}
			document.head.replaceChildren(...new_doc.getElementsByTagName('head')[0].childNodes)
			document.body.replaceChildren(...new_doc.getElementsByTagName('body')[0].childNodes);
			scripts.sort((a,b)=>(a.defer)-(b.defer));
			function process_script (script) {
				if(script.src){
					const prom = new Promise((resolve,reject)=>{
						script.addEventListener('load',()=>{
							resolve();
						})
						document.body.appendChild(script)
					})
					return prom
				}
				else{
					document.body.appendChild(script);
					return (new Promise((resolve,reject)=>{
						const gatescript = document.createElement('script');
						gatescript.onload = resolve;
						gatescript.innerHTML=`
							document.currentScript.onload();document.currentScript.remove();
						`;
						document.body.appendChild(gatescript);
					}));
				}
			};
			for(const script of scripts){
				if(aborted){
					return;
				}
				await process_script(script);
			}
			for(const fn of load_listeners){
				if(aborted){
					return;
				}
				const dummyevent = new Event("load");
				fn(dummyevent);
			}
		}
		finally{
			enter_request=null;
			enter_request_resolve?.();
		}
	}
	window.addEventListener("popstate",(evt)=>{
		//console.log(evt);
		if(evt.state != null){
			setDocument(evt.state)
			followHash(window.location);
		}
		else{
			navigateTo(window.location.href);
		}
	});
	function addAnchorEventListeners(anchors){
		for(const elem of anchors){
			//console.log(elem);
			elem.SPAify ??= {};
			elem.removeEventListener('click', elem.SPAify.listener);
			elem.SPAify.listener = (evt)=>{
				if(!elem || !elem.href || elem.download){
					return;
				}
				if(elem.target && elem.target != "_self"){
					return;
				}
				evt.preventDefault();
				navigateTo(elem.href)
			}
			elem.addEventListener('click',elem.SPAify.listener)
		}
	}
	function addFormEventListeners(forms){
		if(!window.URLSearchParams || !window.FormData){
			return;
		}
		for(const elem of forms){

			//fill in values from fake autocomplete
			const get_hash = (string) => {
				let hash = 0;
				for (const char of string) {
					hash = (hash << 5) - hash + char.charCodeAt(0);
					hash |= 0;
				}
				return hash;
			};
			const form_identifier = "form_submission_"+get_hash(elem.innerHTML);
			let submitted_data = sessionStorage.getItem(form_identifier);
			try{
				submitted_data=JSON.parse(submitted_data);
			}
			catch{
				submitted_data=null;
			}
			if(submitted_data){
				for(const name in submitted_data){
					const value = submitted_data[name];
					for(const inp of elem.querySelectorAll(`[name='${name}']`)){
						if(inp.type=="checkbox"){
							inp.checked = Boolean(value);
						}
						else if(inp.type=="radio"){
							inp.checked = (value == inp.value);
						}
						else if(!(inp.tagName.toLowerCase() == "input" 
							&& ["button","file","image","password","reset","submit"].includes(inp.type))){
							inp.value = value;
						}
					}
				}
			}

			elem.SPAify ??= {};
			elem.removeEventListener('submit', elem.SPAify.listener);
			elem.SPAify.listener = async (evt)=>{
				const elem = evt?.target;
				const submitter = evt?.submitter;
				if(!elem){
					return;
				}

				//populate fake autocomplete
				const submitted_data = {}
				for(const inp of elem.querySelectorAll("input, textarea, select")){
					const name = inp.name
					if(!name){
						continue;
					}
					const autocomplete = (inp.getAttribute("autocomplete")??elem.getAttribute("autocomplete")) != 'off';
					if(autocomplete){
						if(inp.type=="checkbox"){
							submitted_data[name] = inp.checked;
						}
						else if(inp.type=="radio"){
							if(inp.checked){
								submitted_data[name] = inp.value;
							}
						}
						else{
							submitted_data[name] = inp.value;
						}
					}
				}
				sessionStorage.setItem(form_identifier,JSON.stringify(submitted_data));

				const novalidate = submitter?.getAttribute("formnovalidate") || elem.getAttribute("novalidate");
				const target = submitter?.getAttribute("formtarget") || elem.getAttribute("target") || "_self";
				if(target != "_self"){
					return;
				}
				if(!novalidate && !elem.reportValidity()){
					return;
				}
				const action = submitter?.getAttribute("formaction") || elem.getAttribute("action");
				if(!action){
					return;
				}
				const method = submitter?.getAttribute("formmethod") || elem.getAttribute("method") || "GET";
				const enctype = submitter?.getAttribute("formenctype") || elem.getAttribute("enctype") || "application/x-www-form-urlencoded";
				let body = new FormData(elem);
				if(enctype=="application/x-www-form-urlencoded"){
					body = new URLSearchParams(body);
				}
				evt.preventDefault();
				const response = await fetch(action, { body, method });

				if(response.redirected){
					return navigateTo(response.url);
				}
			}
			elem.addEventListener('submit',elem.SPAify.listener)
		}
	}
	const observer = new MutationObserver((records)=>{
		//console.log(records)
		const new_anchors = records.filter(r=>(
			r.type=='childList'
		)).map(x=>{
			if(['a','area'].includes(x.target.tagName.toLowerCase())){
				return [x.target];
			}
			const arr = Array.from(x.target.getElementsByTagName('a'))
			arr.push(...x.target.getElementsByTagName('area'))
			return arr;
		}).flat()
		//console.log(new Set(new_anchors));
		addAnchorEventListeners(new Set(new_anchors));

		const new_forms = records.filter(r=>(
			r.type=='childList'
		)).map(x=>
			x.target.tagName.toLowerCase()=='form'
				?[x.target]
				:Array.from(x.target.getElementsByTagName('form'))
		).flat();
		//console.log(new Set(new_forms));
		addFormEventListeners(new Set(new_forms));
	});
	observer.observe(document.documentElement,{
		subtree:true,
		childList:true
	});

	window.SPAify.navigateTo = navigateTo;
	window.SPAify.navigateToReplace = navigateToReplace;
}
else{
	window.SPAify.navigateTo = (...args)=>window.location.assign(...args);
	window.SPAify.navigateToReplace = (...args)=>window.location.replace(...args);
}
