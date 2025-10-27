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
	FileName varchar(260) not null unique,
	UserID int,
	LocationCount int,
	ScoreModifier double precision check (ScoreModifier > 0) default 1,
	CreateTime timestamp not null default current_timestamp,
	UpdateTime timestamp not null default current_timestamp
);
create table Games (
	GameID serial primary key,
	GameInfo jsonb,
	UserID int references Users(UserID) on delete cascade,
	MapID int references Maps(MapID) on delete cascade,
	ChallengeID int,
	CreateTime timestamp not null default current_timestamp
);
create table Duels (
	DuelID serial primary key,
	DuelInfo jsonb,
	MainUserID int references Users(UserID) on delete cascade,
	OpponentUserID int references Users(UserID) on delete cascade,
	MapID int references Maps(MapID) on delete cascade,
	CreateTime timestamp not null default current_timestamp
);

