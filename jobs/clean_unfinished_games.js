require('dotenv').config({path:__dirname+"/../.env"});
const pg = require('pg');

(async ()=>{
	const pool = new pg.Pool();
	const res = await pool.query("delete from Games where extract(day from current_timestamp-createtime)>45 and (gameinfo->'guesses'->-1)='null'::jsonb;");
	console.log(res);
	pool.end();
})()