(async () => {
	const api_key = localStorage.getItem("maps_api_key") || (await (await fetch('/maps_api_key')).text());
	const url = `https://maps.googleapis.com/maps/api/js?key=${api_key}&loading=async&callback=onMapsLoad&libraries=marker`;
	const script = document.createElement('script');
	script.defer = "";
	script.src = url;
	document.head.appendChild(script);
})();