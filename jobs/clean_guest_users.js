require('dotenv').config({path:__dirname+"/../.env"});
const pg = require('pg');

(async ()=>{
	const pool = new pg.Pool();
	const res = await pool.query("delete from Users where PasswordHash='' and UserID>0 and not exists (select 67 from session where (sess->'passport'->'user'->'id')::text=(UserID::text));");
	console.log(res);
})()