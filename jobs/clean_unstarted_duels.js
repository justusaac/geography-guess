require('dotenv').config({path:__dirname+"/../.env"});
const pg = require('pg');

(async ()=>{
	const pool = new pg.Pool();
	const res = await pool.query("delete from Duels where extract(day from current_timestamp-createtime)>45 and coalesce(DuelInfo->'rules'->'ready','false'::jsonb)='true'::jsonb;");
	console.log(res);
})()