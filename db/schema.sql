create table Users (
	UserID serial primary key,
	Username varchar(30) not null unique,
	PasswordHash char(60) not null,
	CreateTime timestamp not null default current_timestamp
);
insert into Users (UserID, Username, PasswordHash) values (-1, 'Site Administrator', '');
create table Maps (
	MapID serial primary key,
	MapName varchar(64),
	Description varchar(400),
	ObjectID int,
	UserID int references Users(UserID) on delete cascade,
	LocationCount int,
	ScoreModifier double precision check (ScoreModifier > 0) default 1,
	CreateTime timestamp not null default current_timestamp,
	UpdateTime timestamp not null default current_timestamp
);
create table Games (
	GameID uuid primary key default gen_random_uuid(),
	GameInfo jsonb,
	UserID int references Users(UserID) on delete cascade,
	MapID int references Maps(MapID) on delete cascade,
	ChallengeID uuid,
	CreateTime timestamp not null default current_timestamp,
	SortKey int generated always as identity unique
);
create table Duels (
	DuelID uuid primary key default gen_random_uuid(),
	DuelInfo jsonb,
	MainUserID int references Users(UserID) on delete cascade,
	OpponentUserIDs integer[],
	MaxPlayers int default 2,
	Public boolean not null default false,
	Started boolean not null default false,
	MapID int references Maps(MapID) on delete cascade,
	CreateTime timestamp not null default current_timestamp,
	SortKey int generated always as identity unique
);
create table HighScores (
	UserID int references Users(UserID) on delete cascade,
	MapID int references Maps(MapID) on delete cascade,
	GameID uuid references Games(GameID) on delete cascade,
	Score int,
	Elapsed int,
	primary key (UserID, MapID)
);




