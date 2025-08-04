require('dotenv').config({path:__dirname+"/../.env"});
const pg = require('pg');
const fs = require('fs');

(async ()=>{
	const pool = new pg.Pool();
	const result = await pool.query(fs.readFileSync(__dirname+"/schema.sql", "utf8"));
	console.log(result);
})();
