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

const MapFile = require("./map_file_storage.js");
const { score, great_circle_distance } = require("./scoring.js");

app.use(cors());
app.use(express.urlencoded());
app.use(session({
    resave:false,
    saveUninitialized:false,
    secret:crypto.randomBytes(32),
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
async function backupGame(id, gameinfo){
    return db_pool.query('update Games set gameinfo=$1::jsonb where GameID=$2::integer', [gameinfo, id]);
}

function require_auth(req, res, next) {
    if(req.isAuthenticated()){
        return next();
    }
    res.redirect('/login.html');
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
    if(!await check_req_game_id(req)){
        return res.redirect('/login.html');
    }
    next();
}
async function check_duplicate_challenge (req, res, next) {
    const userId = req?.session?.passport?.user?.id;
    const challengeId = parseInt(req?.params?.id);
    if(!challengeId || !userId){
        return res.redirect("/");
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
app.post('/newgame/:id', require_auth, async (req,res) => {
    let time_limit = req.body.time_limit==="on" && (
        1000*60*(Number(req.body.time_limit_minutes) || 0)
        +1000*(Number(req.body.time_limit_seconds) || 0)
    );
    if(isNaN(time_limit)){
        time_limit = false;
    }
    const mapid = Number(req.params.id) || -1;
    const map_result = await db_pool.query("select * from Maps where MapID=$1::int",[mapid])
    const filename = map_result.rows[0]?.filename;
    if(!filename){
        return res.redirect("/")
    }
    const map = await MapFile.open(filename);
    let locations;
    try{
        locations = await map.random_locs(5);
    }
    catch(e){
        console.log(filename,":",e)
        return res.end("Map doesn't have enough locations")
    }
    finally{
        map.close();
    }
    const gameinfo = {
        locations,
        rules:{
            moving:req.body.freedom==="moving",
            zooming:req.body.freedom!=="nmpz",
            panning:req.body.freedom!=="nmpz",
            time_limit
        },
        startTimes:Array(5),
        guesses:Array(5),
    }
    const result = await db_pool.query("insert into Games (UserID, GameInfo, MapID) values ($1::integer, $2::jsonb, $3::integer) returning GameID;", [req.session.passport.user.id, gameinfo, mapid]);
    const gameid = result.rows[0].gameid;
    if(req.body.challenge){
        res.redirect("/pregame/"+gameid);
    }
    else{
        res.redirect("/game/"+gameid);
    }
});
app.post("/challenge/:id", require_auth, check_duplicate_challenge, async (req, res) => {
    const challengeid = Number(req.params.id) || -1
    const original_game = await db_pool.query("select * from Games where GameID=$1::int", [challengeid]);
    if(original_game.rows.length == 0){
        return res.redirect("/");
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
        res.redirect("/")
    }
    res.render('creategame', map);
});
app.get("/pregame/:id", require_auth_game_id, async (req, res) => {
    const game = await getGame(Number(req.params.id) || -1);
    if(!game){
        res.redirect("/")
    }
    res.render('pregame', game);
});
app.get("/createchallenge/:id", require_auth, check_duplicate_challenge, async (req, res) => {
    const original_game = await db_pool.query("select Games.GameID, Games.GameInfo, Maps.MapName, Users.UserName from Games left join Maps on Maps.MapID=Games.MapID left join Users on Users.UserID=Games.UserID where GameID=$1::int", [Number(req.params.id) || -1]);
    if(original_game.rows.length == 0){
        return res.redirect("/");
    }
    res.render('createchallenge', original_game.rows[0]);
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
        const row = await getGame(gameId)
        const gameinfo = row?.gameinfo;
        if(!gameinfo){
            ws.close(4004, "Game not found");
            return
        }
        Object.assign(game, gameinfo);
    }
    await refresh();
    const tentative_guess = {};
    const score_modifier = (await getGame(gameId)).scoremodifier;
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
                    elapsed = Date.now()-game.startTimes[i]
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
        const response = JSON.stringify(check_time_limit() || {
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
                return {
                    type:"game_results",
                    locations: game.locations,
                    guesses:game.guesses,
                    username: req.session.passport.user.username
                };
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
    //Send current game state on connection
    if(!game.startTimes[0]){
        game.startTimes[0] = Date.now();
        backup();
    }
    ws.send(JSON.stringify({
        type:"game_info",
        rules:game.rules,
        mapname:(await getGame(gameId)).mapname
    }));
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
        return {
            type:"game_results",
            locations: game.locations,
            guesses:game.guesses,
            username: req.session.passport.user.username
        }
    })()));
});

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
        successRedirect: '/index.html',
        failureFlash:true,
    })(req,res);
});
app.post("/login-guest", (req, res) => {
    req.flash = (type, msg) => {
        res.end(msg);
    };
    req.body = {username:" ",password:" "};
    passport.authenticate('local-guest', {
        successRedirect: '/index.html',
        failureFlash:true,
    })(req,res);
});
app.get("/logout", (req, res, next) => {
    req.logout(function(err) {
        if (err) { return next(err); }
        res.redirect('/login.html');
    });
});

const server = app.listen(80, function () {
    console.log('CORS-enabled web server listening on port 80')
})
