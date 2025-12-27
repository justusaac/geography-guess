'use strict';
{
	window.gm_stylesheets ??= new Set()
	if(typeof window?.google?.maps?.version !== "string"){
		const stylesheet_observer = new MutationObserver((records)=>{
			const new_stylesheets = records.filter(r=>(r.type=='childList')).map(r=>
				Array.from(r.addedNodes).filter(x=>x.tagName?.toLowerCase?.()=='style')
			).flat()
			/*
			Google puts a "sentinel" selector rule in "most" of the injected style sheets.
			Hopefully they don't change that and nobody else does that
			*/
			let is_google = false;
			stylesheets: for(const style of new_stylesheets){
				for(const rule of style.sheet.cssRules){
					if(rule?.selectorText?.toLowerCase() == 'sentinel'){
						is_google = true;
						break stylesheets;
					}
				}
			}
			if(is_google){
				for(const style of new_stylesheets){
					gm_stylesheets.add(style);
				}
			}
			const linked_stylesheets = records.filter(r=>(r.type=='childList')).map(r=>
				Array.from(r.addedNodes).filter(x=>{
					try{
						return x.tagName?.toLowerCase?.()=='link' && x.rel=="stylesheet" && (new URL(x.href))?.origin?.includes?.("google")
					}
					catch{
						return false;
					}
				})
			).flat()
			for(const style of linked_stylesheets){
				gm_stylesheets.add(style);
			}
		});
		(async () => {
			const api_key = localStorage.getItem("maps_api_key") || (await (await fetch('/maps_api_key')).text());
			const url = `https://maps.googleapis.com/maps/api/js?key=${api_key}&loading=async&callback=onMapsLoad&libraries=marker&v=3.62`;
			const script = document.createElement('script');
			script.defer = "";
			script.src = url;
			stylesheet_observer.observe(document.documentElement,{
				subtree:true,
				childList:true,
			});
			document.head.appendChild(script);
		})();
	}
	else{
		for(const style of window.gm_stylesheets){
			document.head.appendChild(style);
		}
		window.addEventListener('load',()=>{window?.["onMapsLoad"]?.()})
	}
}