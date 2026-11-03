-- Replace Better Auth's tables with our own. Sessions live in KV, so only users are stored here.
create table users (
	id text primary key,
	name text not null,
	email text not null unique,
	password_hash text not null,
	created_at integer not null
);

-- Keep existing email/password accounts; their old hashes are upgraded on next sign-in.
insert into users (id, name, email, password_hash, created_at)
select u.id, u.name, lower(u.email), a.password, cast(strftime('%s', u.createdAt) as integer) * 1000
from "user" u join account a on a.userId = u.id and a.providerId = 'credential'
where a.password is not null;

drop table verification;
drop table session;
drop table account;
drop table "user";
