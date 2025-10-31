"use strict";
require('dotenv').config({path:__dirname+"/.env"});

const http = require('http')
const express = require('express')
const cors = require('cors')
const app = express()
require('express-ws')(app);

const session = require('express-session');
const pg = require('pg');
const db_pool = new pg.Pool();
const bcrypt = require('bcrypt');
const passport = require('passport');
const LocalStrategy = require('passport-local');
const crypto = require('crypto');
const pg_session = require("connect-pg-simple")(session);

const MapFile = require(__dirname+"/map_file_storage.js");
const { score, great_circle_distance } = require(__dirname+"/scoring.js");

app.use(cors());
app.use(express.urlencoded());
app.use(session({
    store: new pg_session({
        pool: db_pool,
        createTableIfMissing:true,
    }),
    resave:false,
    saveUninitialized:false,
    secret:process.env.SESSION_SECRET || crypto.randomBytes(32),
    cookie:{
        maxAge:1000*60*60*24*7
    }
}));
app.use(passport.authenticate('session'));
app.use(express.static(__dirname+'/public'));
app.set("view engine", "ejs");
app.set("views", __dirname+"/views");

async function getGame(id){
    if(!isFinite(id)){
        return null;
    }
    const result = await db_pool.query('select Games.*, Maps.MapName, Maps.MapID, Maps.ScoreModifier from Games left join Maps on Games.MapID=Maps.MapID where GameID=$1::integer;', [id]);
    return result.rows[0];
}
async function getDuel(id){
    if(!isFinite(id)){
        return null;
    }
    const result = await db_pool.query('select Duels.*, Maps.MapName, Maps.MapID, Maps.ScoreModifier, OwnerUsers.Username as OwnerName, OpponentUsers.Username as OpponentName from Duels left join Maps on Duels.MapID=Maps.MapID left join Users as OwnerUsers on Duels.MainUserID=OwnerUsers.UserID left join Users as OpponentUsers on Duels.OpponentUserID=OpponentUsers.UserID where DuelID=$1::integer;', [id]);
    return result.rows[0];
}
async function backupGame(id, gameinfo){
    return db_pool.query('update Games set gameinfo=$1::jsonb where GameID=$2::integer', [gameinfo, id]);
}

function require_auth(req, res, next) {
    if(req.isAuthenticated()){
        return next();
    }
    res.redirect('/login.html?redirect='+encodeURIComponent(req.url));
}
function with_username(obj, req){
    return {...obj, username: req?.session?.passport?.user?.username};
}
async function check_req_game_id(req){
    if(!req.isAuthenticated()){
        return false;
    }
    const userId = req?.session?.passport?.user?.id;
    const gameId = parseInt(req?.params?.id);
    const game = await getGame(gameId);
    if(!game || !userId || game?.userid != userId){
        return false;
    }
    return true;
}
async function require_auth_game_id (req, res, next) {
    require_auth(req,res,async ()=>{
        if(!await check_req_game_id(req)){
            return res.render("forbidden", with_username({},req));
        }
        next();
    });
}
async function check_req_duel_id(req){
    if(!req.isAuthenticated()){
        return false;
    }
    const userId = req?.session?.passport?.user?.id;
    const gameId = parseInt(req?.params?.id);
    const game = await getDuel(gameId);
    if(!game || !userId || (game?.mainuserid != userId && game?.opponentuserid != userId)){
        return false;
    }
    return true;
}
async function require_auth_duel_id (req, res, next) {
    require_auth(req,res,async ()=>{
        if(!await check_req_duel_id(req)){
            return res.render("forbidden", with_username({},req));
        }
        next();
    });
}
async function check_duplicate_challenge (req, res, next) {
    const userId = req?.session?.passport?.user?.id;
    const challengeId = parseInt(req?.params?.id);
    if(!challengeId || !userId){
        return res.redirect("/maplist");
    }
    const response = await db_pool.query("select GameID from Games where UserID=$1::int and (ChallengeID=$2::int or GameID=$2::int)", [userId, challengeId]);
    if(response.rows.length>0){
        return res.redirect("/game/"+response.rows[0].gameid);
    }
    next();
}
app.get('/maps_api_key', require_auth, (req,res) => {
    res.end(process.env.MAPS_API_KEY)
})
async function create_game(res,mapid,userid,rules){
    const map_result = await db_pool.query("select * from Maps where MapID=$1::int",[mapid])
    mapid = map_result.rows[0]?.mapid;
    if(!mapid){
        res.redirect("/maplist")
        return null;
    }
    const map = await MapFile.open(mapid);
    let locations;
    try{
        locations = await map.random_locs(5);
    }
    catch(e){
        console.log("Map",mapid,":",e)
        res.end("Map doesn't have enough locations");
        return null;
    }
    finally{
        map.close();
    }
    const gameinfo = {
        locations,
        rules,
        startTimes:Array(5),
        guesses:Array(5),
    }
    const result = await db_pool.query("insert into Games (UserID, GameInfo, MapID) values ($1::integer, $2::jsonb, $3::integer) returning GameID;", [userid, gameinfo, mapid]);
    const gameid = result.rows[0].gameid;
    return gameid;
}
app.post('/newgame/:id', require_auth, async (req,res) => {
    let time_limit = req.body.time_limit==="on" && (
        1000*60*(Number(req.body.time_limit_minutes) || 0)
        +1000*(Number(req.body.time_limit_seconds) || 0)
    );
    if(isNaN(time_limit)){
        time_limit = false;
    }
    const mapid = Number(req.params.id) || -1;
    const {scoremodifier} = (await db_pool.query("select ScoreModifier from Maps where MapID=$1::int",[mapid])).rows[0];
    const rules = {
        moving:req.body.freedom==="moving",
        zooming:req.body.freedom!=="nmpz",
        panning:req.body.freedom!=="nmpz",
        time_limit,
        scoremodifier
    };
    const gameid = await create_game(res,mapid,req.session.passport.user.id,rules);
    if(!gameid){
        return;
    }
    if(req.body.challenge){
        db_pool.query("update Games set ChallengeID=$1::integer where GameID=$1::integer", [gameid]);
        res.redirect("/pregame/"+gameid);
    }
    else{
        res.redirect("/game/"+gameid);
    }
});
app.get("/playagain/:id", require_auth_game_id, async (req,res) => {
    const game = await getGame(req.params.id);
    if(!game){
        return res.redirect("/maplist");
    }
    const rules = game.gameinfo.rules;
    const mapid = game.mapid;
   
    const gameid = await create_game(res,mapid,req.session.passport.user.id,rules);
    if(!gameid){
        return;
    }
    res.redirect("/game/"+gameid);
});
app.post("/challenge/:id", require_auth, check_duplicate_challenge, async (req, res) => {
    const challengeid = Number(req.params.id) || -1
    const original_game = await db_pool.query("select * from Games where GameID=$1::int", [challengeid]);
    if(original_game.rows.length == 0 || original_game.rows[0].challengeid==null){
        return res.redirect("/maplist");
    }
    const challenge_gameinfo = {
        ...original_game.rows[0].gameinfo,
        startTimes:Array(5),
        guesses:Array(5),
    };
    const mapid = original_game.rows[0].mapid;
    const result = await db_pool.query("insert into Games (UserID, GameInfo, MapID, ChallengeID) values ($1::integer, $2::jsonb, $3::integer, $4::integer) returning GameID;", [req.session.passport.user.id, challenge_gameinfo, mapid, challengeid]);
    const gameid = result.rows[0].gameid;
    res.redirect("/game/"+gameid);
})

app.get("/creategame/:id", require_auth, async (req, res) => {
    const map = (await db_pool.query("select * from Maps where MapID=$1::int",[Number(req.params.id) || -1])).rows[0]
    if(!map){
        res.redirect("/maplist")
    }
    res.render('creategame', with_username(map, req));
});
app.get("/pregame/:id", require_auth_game_id, async (req, res) => {
    const game = await getGame(Number(req.params.id) || -1);
    if(!game){
        res.redirect("/maplist")
    }
    res.render('pregame', with_username(game, req));
});
app.get("/challenge/:id", require_auth, check_duplicate_challenge, async (req, res) => {
    const original_game = await db_pool.query("select Games.GameID, Games.GameInfo, Maps.MapName, Users.UserName as Challenger from Games left join Maps on Maps.MapID=Games.MapID left join Users on Users.UserID=Games.UserID where GameID=$1::int", [Number(req.params.id) || -1]);
    if(original_game.rows.length == 0){
        return res.redirect("/maplist");
    }
    res.render('createchallenge', with_username(original_game.rows[0], req));
});
app.get("/maplist", require_auth, async(req, res) => {
    res.render('maplist', with_username({},req));
});
app.get("/", require_auth, async(req, res) => {
    res.render('maplist', with_username({},req));
});

app.get("/game/:id", require_auth_game_id, (req, res) => {
    res.sendFile(__dirname+'/public/mapview.html');
});

app.ws("/gamesession/:id", async (ws, req) => {
    if(!await check_req_game_id(req)){
        ws.close(3001, "Not authenticated");
        return
    }
    const gameId = parseInt(req.params.id);
    const game = {};
    const backup = async () => backupGame(gameId, game);
    const refresh = async () => {
        const row = await getGame(gameId);
        const gameinfo = row?.gameinfo;
        if(!gameinfo){
            ws.close(4004, "Game not found");
            return
        }
        Object.assign(game, gameinfo);
    }
    await refresh();
    const tentative_guess = {};
    const score_modifier = (await getGame(gameId)).gameinfo.rules.scoremodifier;
    const process_guess = (guess,actual) => {
        let points = 0;
        let distance = 0;
        if(guess.lat != undefined && guess.lng != undefined){
            distance = great_circle_distance(guess, actual);
            points = score(distance, score_modifier)
        }
        if(isNaN(points)){
            points = 0;
        }
        return {
            location:guess,
            score:points,
            distance
        };
    };
    const check_time_limit = () => {
        if(!game.rules.time_limit){
            return;
        }
        for(let i=0; i<game.locations.length; i++){
            if(!game.guesses[i]){
                if(game.startTimes[i]){
                    const elapsed = Date.now()-game.startTimes[i]
                    if(elapsed>game.rules.time_limit){
                        const real_location = game.locations[i];
                        const guess = process_guess({...tentative_guess},real_location);
                        guess.elapsed = game.rules.time_limit
                        guess.location.lat ??= 0;
                        guess.location.lng ??= 0;
                        game.guesses[i] = guess;
                        backup();
                        return {
                            type:"round_results",
                            round:i,
                            guess,
                            actual:real_location,
                        };
                    }
                    return;
                }
            }
        }
    };
    const get_game_results = () => {
        return {
            type:"game_results",
            locations: game.locations,
            guesses:game.guesses,
            username: req.session.passport.user.username
        }
    };
    const get_challengers = async () => {
        const row = await getGame(gameId);
        const challengeId = row.challengeid;
        if(!challengeId){
            return {};
        }
        const rows = (await db_pool.query("select Games.GameInfo, Users.Username from Games left join Users on Users.UserID=Games.UserID where Games.ChallengeID=$1::integer or Games.GameID=$1::integer", [challengeId])).rows;
        const ans = {}
        for(const row of rows){
            const guesses = row.gameinfo.guesses;
            //Only including completed challenges
            if(guesses[guesses.length-1]){
                ans[row.username] = guesses;
            }
        }
        return ans;
    };
    ws.on('message', async (msg) => {
        let data_;
        try{
            data_ = JSON.parse(msg);
        }
        catch (error){
            return;
        }
        const data = data_;
        if(data?.type != "update_guess"){
            await refresh();
        }
        const response = JSON.stringify(check_time_limit() || await {
            //Keys based on data.type
            next_round:()=>{
                let score_so_far = 0;
                for(let i=0; i<game.locations.length; i++){
                    if(!game.guesses[i]){
                        if(game.startTimes[i]){
                            return {
                                type:"error",
                                message:"Finish the current round first"
                            };
                        }
                        game.startTimes[i] = Date.now();
                        backup()
                        tentative_guess.lat = undefined;
                        tentative_guess.lng = undefined;
                        return {
                            type:"round",
                            round:i,
                            location:game.locations[i],
                            start_time:game.startTimes[i],
                            score_so_far
                        };
                    }
                    score_so_far += game.guesses[i].score;
                }
                return get_game_results();
            },
            show_challengers:async ()=>{
                if(!game.guesses[game.guesses.length-1]){
                    return;
                }
                const results = get_game_results();
                results.challengers = await get_challengers();
                return results;
            },

            update_guess:()=>{
                tentative_guess.lat = data.location.lat;
                tentative_guess.lng = data.location.lng;
            },

            confirm_guess:()=>{
                if(game.guesses[data.round]){
                    return {
                        type:"error",
                        message:`You've already made a guess for round ${data.round+1}.`
                    };
                }
                if(!game.startTimes[data.round]){
                    return {
                        type:"error",
                        message:`Round ${data.round+1} has not started yet.`
                    };
                }
                const guess_location = {...tentative_guess, ...data.location};
                const real_location = game.locations[data.round]
                const guess = process_guess(guess_location,real_location);
                guess.elapsed = Date.now()-game.startTimes[data.round];
                game.guesses[data.round] = guess;
                backup();
                return {
                    type:"round_results",
                    round:data.round,
                    guess,
                    actual:real_location,
                };

            },

        }[data.type]?.());
        if(response){
            ws.send(response)
        }
    });
    if(!game.startTimes[0]){
        game.startTimes[0] = Date.now();
        backup();
    }
    //Send current game state on connection
    {
        const gameinfo = await getGame(gameId);
        ws.send(JSON.stringify({
            type:"game_info",
            rules:game.rules,
            mapname:gameinfo.mapname,
            mapid:gameinfo.mapid
        }));
    }
    ws.send(JSON.stringify(check_time_limit() || (() => {

        let score_so_far = 0;
        for(let i=0; i<game.locations.length; i++){
            if(!game.guesses[i]){
                if(game.startTimes[i]){
                    return {
                        type:"round",
                        round: i,
                        location:game.locations[i],
                        start_time:game.startTimes[i],
                        score_so_far
                    };
                }
                return {
                    type:"round_results",
                    round:i-1,
                    guess:game.guesses[i-1],
                    actual:game.locations[i-1]
                };
            }
            score_so_far += game.guesses[i].score;
        }
        return get_game_results();
    })()));
});

const find_world_map = async (userid)=>{
    const res = await db_pool.query("select Maps.MapID from Maps where lower(Maps.MapName)='world' and UserID=$1::int",[userid]);
    return res.rows[0]?.mapid;
}

app.post('/maps', require_auth, async (req,res) => {
    const page = req.body.page ?? 0;
    const number = req.body.count ?? 20;
    const query = req.body.query ?? "";
    const result = await db_pool.query('select Maps.MapID, Maps.MapName, Maps.Description, Users.UserID, Users.Username from Maps left join Users on Maps.UserID=Users.UserID where lower(Maps.MapName) like lower($3) order by Maps.MapID limit $1::int offset $2::int', [number, page*number, '%'+query+'%'])
    res.end(JSON.stringify(result?.rows))
});

app.post("/register", (req, res) => {
    if(!req.body || !req.body.password || !req.body.username){
        return res.end("Necessary registration information not provided");
    }
    if(!/^[A-Za-z0-9-_]+$/.test(req.body.username)){
        return res.end("Prohibited characters in username");
    }
    bcrypt.hash(req.body.password, 13, async (err, hash) => {
        try{
            const result = await db_pool.query('insert into Users (Username, PasswordHash) values ($1::text, $2::text);', [req.body.username, hash]);
            res.redirect('/login.html')
        } catch(error) {
            res.end(({
                '23505':'Username is already in use',
                '22001':'Username is too long'
            }[error.code] ?? 'Unknown error occurred in registration'));
        }
    })
});

passport.use(new LocalStrategy(async (username, password, next) => {
    if(!username || !password){
        return next(null, false, {message: "Missing username or password"});
    }
    const result = await db_pool.query('select * from users where Username=$1::text;', [username]);
    bcrypt.compare(password, result?.rows?.[0]?.passwordhash || "", (err, match) => {
        if(err){
            return next(err);
        }
        else if(!match){
            return next(null, false, {message:"No match for username+password"});
        }
        else{
            return next(null, {userid: result.rows[0].userid, username: result.rows[0].username});
        }
    });
}));
passport.use('local-guest', new LocalStrategy(async (username, password, next) => {
    username = "Guest-"+crypto.randomBytes(17).toString('base64url');
    try{
        const result = await db_pool.query('insert into Users (Username, PasswordHash) values ($1::text, $2::text) returning UserID, Username;', [username, ""]);
        return next(null, {userid: result.rows[0].userid, username: result.rows[0].username});
    } catch(error) {
        return next(error)
    }
}));
passport.serializeUser((user, next) => {
    next(null, {id:user.userid, username: user.username});
});
passport.deserializeUser((user, next) => {
    return next(null, user);
});
app.post("/login", (req, res) => {
    req.flash = (type, msg) => {
        res.end(msg);
    };
    passport.authenticate('local', {
        successRedirect: '/maplist',
        failureFlash:true,
    })(req,res);
});
app.post("/login-guest", (req, res) => {
    req.flash = (type, msg) => {
        res.end(msg);
    };
    req.body = {username:" ",password:" "};
    passport.authenticate('local-guest', {
        successRedirect: '/maplist',
        failureFlash:true,
    })(req,res);
});
app.get("/logout", (req, res, next) => {
    req.logout(function(err) {
        if (err) { return next(err); }
        res.redirect('/login.html');
    });
});

const create_duel = async (rules, userid, mapid) =>{
    const gameinfo = {
        rules,
        guesses:[],
        locations:[],
        startTimes:[],
        finishTimes:[],
        health_before:[]
    }
    const result = await db_pool.query("insert into Duels (MainUserID, DuelInfo, MapID) values ($1::integer, $2::jsonb, $3::integer) returning DuelID;", [userid, gameinfo, mapid]);
    const duelid = result.rows[0].duelid;
    return duelid;
}
app.post("/createduel/:id", require_auth, async (req, res)=> {
    const userid = req?.session?.passport?.user?.id;
    const mapid = Number(req.params.id) || -1;
    const map = (await db_pool.query("select ScoreModifier from Maps where MapID=$1::int",[mapid])).rows[0]
    if(!map){
        res.redirect("/maplist");
    }
    const duelid = await create_duel({
        moving:true,
        panning:true,
        zooming:true,
        time_limit:false,
        time_limit_after_guess:15000,
        max_health:6000,
        scoremodifier:map.scoremodifier
    }, userid, mapid);
    res.redirect(`/duelroom/${duelid}`);
});

app.get("/settings", require_auth, (req,res)=>{
    return res.render("settings", with_username({},req));
});
app.get("/duelroom/:id", require_auth, async (req,res)=>{
    const result = await db_pool.query("select Maps.MapName, Maps.MapID from Duels left join Maps on Maps.MapID=Duels.MapID where DuelID=$1::int", [req.params.id]);
    if(!result.rows.length){
        return res.redirect("/maplist");
    }
    const {mapid,mapname} = result.rows[0];
    return res.render("duelroom", with_username({mapname,mapid},req));
});
app.ws("/duelroomsession/:id", async (ws,req) => {
    const duelId = parseInt(req.params.id);
    const userId = req?.session?.passport?.user?.id;
    if(userId == null){
        ws.close(3001, "Not authenticated");
        return
    }
    const username = req?.session?.passport?.user?.username;

    const client = new pg.Client();
    await client.connect();

    const channelId = `duelroom_${duelId}`
    if(!/^[A-Za-z0-9-_]+$/.test(channelId)){
        return;
    }
    await client.query("begin;")
    const row = (await client.query("select Duels.*, OwnerUsers.Username as ownername, OpponentUsers.Username as opponentname,  Maps.MapName, Maps.ScoreModifier from Duels left join Users as OwnerUsers on Duels.MainUserID=OwnerUsers.UserID left join Users as OpponentUsers on Duels.OpponentUserID=OpponentUsers.UserID left join Maps on Maps.MapID=Duels.MapID where DuelID=$1::integer for update of Duels", [duelId])).rows[0];
    if(!row){
        ws.close(3001, "Duel not found");
        return;
    }
    if(row.duelinfo?.rules?.ready){
        ws.send(JSON.stringify({type:"start_duel"}));
        ws.close(3001, "Duel started already");
        return;
    }
    const notify_player_list = async () => client.query(`select pg_notify($1::text, CONCAT('{"type": "update_player_list", "info":{"owner":"', OwnerUsers.Username, '", "users":["', OwnerUsers.Username, '","' || OpponentUsers.Username, '"]}}')) from Duels left join Users as OwnerUsers on Duels.MainUserID=OwnerUsers.UserID left join Users as OpponentUsers on Duels.OpponentUserID=OpponentUsers.UserID where DuelID=$2::int;`, [channelId, duelId]);
    const leave_room = async () => {
        await client.query("begin;");
        await client.query("select 67 from Duels where DuelID=$1::int for update;", [duelId]);
        await client.query(`
            update Duels set OpponentUserId=null where OpponentUserId=$1::integer and DuelID=$2::integer;
        `, [userId, duelId]);
        await notify_player_list();
        await client.query("commit");
    }
    ws.on('close',async ()=>{
        client.end()
    });
    const is_owner = row.mainuserid === userId;
    client.on("notification", (msg)=>{
        const payload = JSON.parse(msg.payload);
        const {type,info} = payload;
        if(type == "update_player_list"){
            if(!info.users.includes(username)){
                ws.close(3001, "You left");
                return;
            }
            ws.send(JSON.stringify(payload));
        }
        else if(type == "update_rules"){
            ws.send(JSON.stringify(payload))
        }
        else if(type == "start_duel"){
            ws.send(JSON.stringify(payload))
        }
    });
    // I dont think this can be done with prepared statements
    await client.query(`listen "${channelId}"`);

    //Reject if full, join if not in, send message if already in
    if(is_owner || row.opponentname == username){
        await notify_player_list();
    }
    else if(row.opponentname != null){
        ws.close(3001, "Duel is full");
        return;
    }
    else{

        await client.query(`
            update Duels set OpponentUserID=$2::int where DuelID=$1::int and OpponentUserID is null;
        `, [duelId, userId]);
        await notify_player_list();
    }
    await client.query("commit;");
    ws.on("message", async (msg)=>{
        let data;
        try{
            data = JSON.parse(msg);
        }
        catch (error){
            return;
        }
        const {type,info} = data;
        if(type == "update_rules"){
            if(is_owner){
                const filtered_info = {
                    moving:Boolean(info.moving),
                    zooming:Boolean(info.zooming), 
                    panning:Boolean(info.panning),
                    time_limit:info.time_limit==null ? info.time_limit : Number(info.time_limit),
                    time_limit_after_guess:info.time_limit_after_guess==null ? info.time_limit_after_guess : Number(info.time_limit_after_guess),
                    max_health: Math.abs(Number(info.max_health)) || 1,
                    scoremodifier:row.scoremodifier
                };
                await client.query("begin;");
                await client.query("select 67 from Duels where DuelID=$1::int for update;", [duelId]);
                await client.query(`
                    update Duels set DuelInfo=jsonb_set(DuelInfo, '{rules}', $2::jsonb, true) where DuelID=$1::integer;
                `, [duelId, filtered_info]);
                await client.query(`select pg_notify($1::text, '{"type":"update_rules", "info":' || jsonb_pretty(DuelInfo->'rules') || '}') from Duels where DuelID=$2::integer;
                `, [channelId, duelId]);
                await client.query("commit;");
            }
        }
        if(type == "start_duel"){
            if(is_owner){
                await client.query(`
                    update Duels set DuelInfo=jsonb_set(DuelInfo, '{rules,ready}', 'true'::jsonb, true) where DuelID=$1::integer;
                `, [duelId]);
                await client.query(`
                    select pg_notify($1::text, '{"type":"start_duel"}');
                `, [channelId]);
            }
        }
    });
    ws.send(JSON.stringify({
        type:"update_rules",
        info:row.duelinfo.rules
    }));

});

app.get("/duel/:id", require_auth_duel_id, async (req, res) => {
    res.sendFile(__dirname+'/public/duelview.html');
});
const check_duel_finished = (duel)=>{
    // If less than 2 players have health left then the games over
    return duel.health_before.length>0 && Object.values(duel.health_before[duel.health_before.length-1]).reduce((acc,curr)=>acc+(curr>0), 0)<2
}
app.ws("/duelsession/:id", async (ws, req) => {
    if(!await check_req_duel_id(req)){
        ws.close(3001, "Not authenticated");
        return
    }
    const duelId = parseInt(req.params.id);

    const client = new pg.Client();
    await client.connect()
    ws.on('close',()=>client.end());
    await client.query('begin');
    const duelrow = {}
    try{
        const row = (await client.query('select Duels.*, Maps.MapName, Maps.MapID, OwnerUsers.Username as OwnerName, OpponentUsers.Username as OpponentName from Duels left join Maps on Duels.MapID=Maps.MapID left join Users as OwnerUsers on Duels.MainUserID=OwnerUsers.UserID left join Users as OpponentUsers on Duels.OpponentUserID=OpponentUsers.UserID where DuelID=$1::integer for update of Duels;', [duelId])).rows[0];
        Object.assign(duelrow, row);
    }
    catch{
        return;
    }
    const duel = duelrow?.duelinfo;
    if(!duel){
        ws.close(4004, "Game not found");
        return
    }
        
    if(!duel.rules?.ready){
        ws.close(4004, "Not ready");
        return;
    }


    const score_modifier = duelrow.duelinfo.rules.scoremodifier;
    const process_guess = (guess,actual) => {
        let points = 0;
        let distance = 0;
        if(guess.lat != undefined && guess.lng != undefined){
            distance = great_circle_distance(guess, actual);
            points = score(distance, score_modifier)
        }
        if(isNaN(points)){
            points = 0;
        }
        return {
            location:guess,
            score:points,
            distance
        };
    };

    const send_current_state = ()=>{
        let current_round = -1;
        while(duel.startTimes[current_round+1]){
            current_round++;
        }
        if(current_round==-1){
            return;
        }
        if(duel.finishTimes[current_round]){
            ws.send(JSON.stringify({
                type:"round_results",
                round:current_round,
                location:duel.locations[current_round],
                finish_time:duel.finishTimes[current_round],
                health_before:duel.health_before[current_round],
                guesses:duel.guesses[current_round]
            }));
        }
        else{
            if(check_duel_finished(duel)){
                ws.send(JSON.stringify({
                    type:"game_results",
                    locations:duel.locations,
                    health_before:duel.health_before,
                    guesses:duel.guesses,
                    startTimes:duel.startTimes,
                    finishTimes:duel.finishTimes
                }));
            }
            else{
                ws.send(JSON.stringify({
                    type:"round",
                    round:current_round,
                    location:duel.locations[current_round],
                    start_time:duel.startTimes[current_round],
                    health_before:duel.health_before[current_round],
                    guesses:duel.guesses[current_round]
                }));
            }
        }
    };

    const finish_round = async (round_idx) =>{
        const now = Date.now();
        await client.query("begin;");
        const duelinfo = (await client.query("select Duels.DuelInfo from Duels where DuelID=$1::int for update;", [duelId])).rows[0].duelinfo;
        duelinfo.finishTimes[round_idx] = Date.now();
        const res = await client.query(`update Duels set DuelInfo=$3::jsonb where DuelID=$1::int and jsonb_array_length(DuelInfo->'finishTimes')=$2::int`, [duelId, round_idx, duelinfo]);
        if(res.rowCount>0){
            await client.query(`select pg_notify($1::text, '{"type":"finish_round","info":{
            "index":' || $2::integer 
            || ', "finish_time":' || (DuelInfo->'finishTimes'->$2::integer) 
            || '}}') from Duels where DuelID=$3::int`, [channelId, round_idx, duelId]);
        }
        else{
            send_current_state();
        }
        await client.query("commit;");
    }  

    client.on("notification", (msg)=>{
        const payload = JSON.parse(msg.payload);
        const {type,info} = payload;
        if(type=="new_round"){
            duel.locations[info.index] = info.location;
            duel.startTimes[info.index] = info.start_time;
            duel.health_before[info.index] = info.health_before;
            duel.guesses[info.index] ??= {};
        }
        else if(type=="finish_round"){
            duel.finishTimes[info.index] = info.finish_time;
        }
        else if(type=="update_guess"){
            const {round, user, guess} = info;
            duel.guesses[round][user] = guess;
            if(Object.keys(duel.health_before[round]).map((u)=>duel.guesses[round][u]?.final).reduce((a,b)=>a&&b, true)){
                finish_round(round);
                return;
            }
        }
        else if(type=="new_duel"){
            ws.send(JSON.stringify({
                type:"new_duel",
                new_id:info
            }));
            return;
        }
        send_current_state();
    });

    const channelId = `duel_${duelId}`
    if(!/^[A-Za-z0-9-_]+$/.test(channelId)){
        return;
    }
    await client.query(`listen "${channelId}"`);

    const add_new_round = async (round_idx) =>{
        //Check if the game has already ended
        await client.query("begin;");
        const duelinfo = (await client.query("select Duels.DuelInfo from Duels where DuelID=$1::int for update;", [duelId])).rows[0].duelinfo;
        if(round_idx==0){
            duelinfo.health_before[round_idx] = {[duelrow.ownername]:duel.rules.max_health, [duelrow.opponentname]:duel.rules.max_health};
        }
        else{
            duelinfo.health_before[round_idx] = {};
            const last_round_guesses = duelinfo.guesses[round_idx-1];
            const max_score = Object.values(last_round_guesses).reduce((acc,curr)=>Math.max(acc,curr.score),0);
            const last_round_health = duelinfo.health_before[round_idx-1];
            for(const user in last_round_health){
                const new_health = Math.max(0,last_round_health[user]-(max_score-(last_round_guesses[user]?.score||0)));
                duelinfo.health_before[round_idx][user] = new_health;
            }
        }
        if(Object.values(duelinfo.health_before[round_idx]).reduce((acc,curr)=>acc+(curr>0), 0)>1){
            //If the game will end with this new round dont bother adding a location for it
            const map = await MapFile.open(duelrow.mapid);
            const location = await map.random_loc();
            map.close();
            duelinfo.locations[round_idx] = location;
        }
        else{
            duelinfo.locations[round_idx] = {};
        }
        duelinfo.guesses[round_idx] = {};
        duelinfo.startTimes[round_idx] = Date.now();
        const res = await client.query(`update Duels set DuelInfo=$3::jsonb where DuelID=$1::int and jsonb_array_length(DuelInfo->'locations')=$2::int`, [duelId, round_idx, duelinfo]);

        if(res.rowCount>0){
            await client.query(`select pg_notify($1::text, '{"type":"new_round","info":{
                "index":' || $2::integer 
                || ', "location":' || (DuelInfo->'locations'->$2::integer) 
                || ', "start_time":' || (DuelInfo->'startTimes'->$2::integer) 
                || ', "health_before":' || (DuelInfo->'health_before'->$2::integer) 
                || '}}') from Duels where DuelID=$3::int`, [channelId, round_idx, duelId]);
        }
        else{
            send_current_state();
        }
        await client.query("commit;");
    }  
    const check_time_limit = async ()=>{
        if(check_duel_finished(duel)){
            return;
        }
        const now = Date.now();
        const {time_limit, time_limit_after_guess} = duel.rules;
        let current_round = -1;
        while(duel.startTimes[current_round+1]){
            current_round++;
        }
        if(current_round==-1){
            await add_new_round(current_round+1);
            return true;
        }
        else if(duel.finishTimes[current_round]){
            //12 seconds time for viewing round results
            if(now-duel.finishTimes[current_round]>12000){
                await add_new_round(current_round+1);
                return true;
            }
        }
        else{
            const lock_in_time = Object.values(duel.guesses[current_round]).reduce((acc,curr)=>{
                if(!acc){
                    return curr.final;
                }
                if(!curr.final){
                    return acc;
                }
                return Math.min(acc,curr.final)
            }, false);
            let time_left = (duel.rules.time_limit || Infinity)-(now-duel.startTimes[current_round]);
            if(lock_in_time){
                time_left = Math.min(time_left,
                    (duel.rules.time_limit_after_guess || Infinity)-(now-lock_in_time)
                );
            }
            if(time_left<0){
                await finish_round(current_round);
                return true;
            }
        }
    };
    const update_guess = async (location, round, final) =>{
        if(duel.finishTimes[round]){
            ws.send(JSON.stringify({
                type:"error",
                message:`Round ${round+1} is already finished.`
            }));
            return;
        }
        location = {lat:location.lat,lng:location.lng};
        const result = process_guess(location, duel.locations[round]);
        result.final = final && Date.now();
        const username = req.session.passport.user.username;
        await client.query('begin');
        await client.query('select 67 from Duels where DuelID=$1::int for update;',[duelId]);
        const res = await client.query(`
            update Duels set DuelInfo=jsonb_set(DuelInfo, ARRAY['guesses', $3::text, $2::text], $4::jsonb, true) where DuelID=$1::int and 
            jsonb_typeof(DuelInfo->'guesses'->$3::integer->$2::text->'final') is distinct from 'number';
        `,[duelId, username, round, result]);
        if(res.rowCount>0){
            await client.query(`select pg_notify($2::text, '{"type":"update_guess", "info":{"round":' || $3::integer || ', "user": "' || $4::text || '", "guess":' || (DuelInfo->'guesses'->$3::integer->$4::text) || '}}') from Duels where DuelID=$1::int;`,[duelId, channelId, round, username]);
        }
        else{
            send_current_state();
        }
        await client.query("commit;");
    };

    ws.send(JSON.stringify({
        type:"game_info",
        you:req.session.passport.user.username,
        owner:duelrow.ownername,
        rules:duel.rules,
        mapname:duelrow.mapname,
        mapid:duelrow.mapid
    }));
    (await check_time_limit()) || (send_current_state());
    await client.query("commit;");
    ws.on("message", async (msg)=>{
        if(await check_time_limit()){
            return;
        }
        let data_;
        try{
            data_ = JSON.parse(msg);
        }
        catch (error){
            return;
        }
        const data = data_;
        if(data.type == "update_guess"){
            await update_guess(data.location, data.round, false);
        }
        else if(data.type == "confirm_guess"){
            await update_guess(data.location, data.round, true);
        }
    });
});

app.get("/duelagain/:id", require_auth, async (req,res) => {
    const duelId = Number(req.params.id);
    const result = (await db_pool.query("select DuelInfo, MainUserID, MapID from Duels where DuelID=$1::integer", [duelId])).rows[0];
    if(!result){
        return res.redirect("/maplist");
    }
    if(result.mainuserid != req?.session?.passport?.user?.id){
        return res.render("forbidden", with_username({},req));
    }
    //Dont play again if it hasnt finished yet
    if(!check_duel_finished(result.duelinfo)){
        return res.redirect("/duel/"+duelId);
    }
    const rules = result.duelinfo.rules;
    rules.ready = false;
    const new_duelId = await create_duel(rules, result.mainuserid, result.mapid);
    if(!new_duelId){
        return res.redirect("/duel/"+duelId);
    }
    const channelId = `duel_${duelId}`;
    //Redirect other users in the original duel to the new one
    await db_pool.query(`select pg_notify($1::text, '{"type":"new_duel", "info":' || DuelID || '}') from Duels where DuelID=$2::integer`, [channelId, new_duelId]);
    res.redirect("/duelroom/"+new_duelId);
});

app.get("/dailychallenge", async (req,res)=>{
    const site_admin_user_id = -1;
    const worldmapid = await find_world_map(site_admin_user_id);
    if(worldmapid==null){
        return res.end("World map not found");
    }
    const now = (await db_pool.query("select current_timestamp;")).rows[0].current_timestamp;
    const existing = await db_pool.query("select ChallengeID from Games where UserID=$1::int and CreateTime::date=$2::date", [site_admin_user_id, now]);
    const existing_row = existing.rows[0];
    if(existing_row?.challengeid == null){
        const map = await MapFile.open(worldmapid);
        let locations;
        try{
            locations = await map.random_locs(5);
        }
        catch(e){
            console.log("Map",worldmapid,":",e)
            return res.end("World map doesn't have enough locations");
        }
        finally{
            map.close();
        }
        const {scoremodifier} = (await db_pool.query("select ScoreModifier from Maps where MapID=$1::int",[worldmapid])).rows[0];
        const rules = {
            time_limit:120000,
            moving:true,
            panning:true,
            zooming:true,
            scoremodifier
        };
        const gameinfo = {
            locations,
            rules,
            startTimes:Array(5),
            guesses:Array(5),
        }
        await db_pool.query(`insert into Games (UserID, GameInfo, MapID) select $1::integer, $2::jsonb, $3::integer where not exists(
                select 67 from Games where UserID=$1::int and CreateTime::date=$4::date
            )`,[site_admin_user_id, gameinfo, worldmapid, now]);
        const result = await db_pool.query(`update games set ChallengeID=GameID where UserID=$1::int and CreateTime::date=$2::date returning ChallengeID;`, [site_admin_user_id, now]);
        const new_challengeid = result.rows[0].challengeid;
        res.redirect("/challenge/"+new_challengeid);
    }
    else{
        res.redirect("/challenge/"+existing_row.challengeid);
    }
});


const port = process.env.PORT ?? 80;
const server = app.listen(port, function () {
    console.log(`Web server listening on port ${port}`)
})
