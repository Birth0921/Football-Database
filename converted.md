AUTONOMOUS FOOTBALL DATA PLATFORM — COMPLETE BUILD SPECIFICATION

You are the lead software architect, backend engineer, database engineer, data engineer, DevOps engineer, API engineer, and QA engineer for this project.

Your task is to independently design, implement, configure, run, test, and verify a complete production-ready football data platform using API-Football as the external football data provider.

Do not stop at creating files or giving instructions.

You must actually:

* create the project
* create the database schema
* run migrations
* configure PostgreSQL
* configure Redis
* connect to API-Football
* verify the API credentials
* fetch football data
* store raw provider data
* normalize the data
* calculate derived statistics
* create prediction features
* build our own REST API
* build our own API-key authentication
* implement synchronization workers
* implement caching
* run tests
* perform an initial data import
* verify the complete pipeline

If something is ambiguous, make a reasonable engineering decision, document it, and continue.

Do not repeatedly ask for permission for normal implementation decisions.

Only ask me when you genuinely require a secret, credential, infrastructure resource, or decision that cannot safely be inferred.

⸻

1. PRIMARY OBJECTIVE

Build this complete system:

API-Football
↓
Provider Sync Engine
↓
Raw API Response Storage
↓
Normalized PostgreSQL Database
↓
Derived Football Statistics
↓
Prediction Features
↓
Redis Cache
↓
OUR FOOTBALL API
↓
Website + Prediction App + Other Clients

The website and prediction application must use OUR API.

They must NOT directly call API-Football.

The API-Football key must remain private on the backend.

⸻

2. EXTERNAL FOOTBALL PROVIDER

Provider:

API-Football

Current available quota:

approximately 75,000 requests/day.

Use this quota intelligently.

Do not blindly consume the entire quota.

Build a quota-aware synchronization system.

The system must inspect API-Football coverage before requesting detailed endpoints.

Not every competition or season necessarily has every statistic.

Store coverage information for every competition/season.

Only request endpoints supported by that competition/season.

⸻

3. TECHNOLOGY STACK

Use:

Backend:

* Node.js
* TypeScript
* REST API

Database:

* PostgreSQL

Cache:

* Redis

Background jobs:

* BullMQ or another Redis-backed reliable job queue

ORM/query layer:

* Prisma, Drizzle, or another production-grade PostgreSQL solution

Containerization:

* Docker
* docker-compose for local development

API documentation:

* OpenAPI / Swagger

Testing:

* unit tests
* integration tests
* database tests
* API tests
* synchronization tests

Use environment variables/secrets for:

API_FOOTBALL_KEY
DATABASE_URL
REDIS_URL
API_PORT
API_BASE_URL
JWT_SECRET or equivalent secret
ADMIN credentials/secrets where required

Never hard-code secrets.

Never commit .env.

Create .env.example.

⸻

4. TWO DIFFERENT API KEY SYSTEMS

There are two completely separate credentials.

A. API-FOOTBALL KEY

This is the external provider credential.

It is used only by:

OUR BACKEND → API-FOOTBALL

It must never be exposed to:

* website frontend
* prediction app
* mobile app
* browser
* public API response
* logs
* client-side JavaScript

Store it as:

API_FOOTBALL_KEY

using the environment/secrets system.

⸻

B. OUR OWN API KEYS

Our platform must generate and manage its own API keys.

These keys are used by:

Prediction App → OUR FOOTBALL API

Website/backend → OUR FOOTBALL API

Other authorized applications → OUR FOOTBALL API

Example:

Prediction App
      ↓
X-API-Key: pf_live_xxxxxxxxx
      ↓
OUR API
      ↓
PostgreSQL / Redis

The prediction app must never need the API-Football key.

⸻

5. OWN API KEY DATABASE

Create these tables:

api_clients
api_keys
api_usage

api_clients

Fields:

id
name
description
client_type
active
rate_limit_per_minute
rate_limit_per_day
created_at
updated_at

Examples:

Prediction App
Website
Mobile App
Admin Dashboard
Internal Service

⸻

api_keys

Fields:

id
client_id
key_prefix
key_hash
scopes
created_at
last_used_at
expires_at
revoked_at
updated_at

IMPORTANT:

Never store the complete raw API key in PostgreSQL.

Only store:

* key prefix
* secure cryptographic hash

Use a cryptographically secure random generator.

Example:

pf_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

The exact format may be chosen by the implementation, but keys must be long and unpredictable.

⸻

6. API KEY GENERATION

Create a secure API-key generation service.

When an administrator creates a key:

1. Generate a cryptographically secure random secret.
2. Add an identifiable prefix.
3. Hash the complete key using a secure one-way hashing method.
4. Store only the hash and prefix.
5. Display the complete key ONE TIME.
6. Allow the administrator to copy it.
7. Never display the complete key again after the creation screen is closed.
8. Associate the key with an API client.
9. Apply scopes.
10. Apply rate limits.
11. Record creation time.

Example:

Client:
Prediction App
Generated API key:
pf_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXX

The complete secret must only be visible during creation.

⸻

7. OWN API KEY ADMIN UI

Create:

/admin/api-keys

The administrator must be able to:

* create API client
* generate API key
* see key prefix
* see client name
* see scopes
* see creation date
* see expiration date
* see last-used date
* revoke key
* rotate key
* create replacement key
* configure rate limits
* enable/disable client
* view usage

Never display the complete secret after creation.

⸻

8. API KEY ROTATION

Implement key rotation.

When rotating:

1. Generate a new key.
2. Show the new key once.
3. Allow the administrator to copy it.
4. Optionally keep the old key active for a configurable grace period.
5. Revoke the old key after the grace period.
6. Record the rotation event.

Do not unexpectedly break the consuming application during rotation unless explicitly requested.

⸻

9. API KEY REVOCATION

Allow immediate revocation.

A revoked key must immediately stop authenticating.

Do not delete historical usage records.

Mark the key as revoked.

⸻

10. API KEY AUTHENTICATION

All protected API endpoints must support:

X-API-Key: pf_live_xxxxxxxxx

Authentication process:

1. Receive API key.
2. Determine prefix.
3. find corresponding key record.
4. verify secure hash.
5. check revoked status.
6. check expiration.
7. check client active status.
8. check requested scope.
9. check rate limit.
10. record usage.
11. process request.

Never log the full API key.

⸻

11. API KEY SCOPES

Support scopes such as:

fixtures:read
teams:read
players:read
referees:read
standings:read
statistics:read
predictions:read
admin:read
admin:write

Prediction App can receive only the scopes it needs.

Do not give normal applications administrative permissions.

⸻

12. API USAGE TRACKING

Track:

api_key_id
client_id
date
requests
successful_requests
failed_requests
rate_limited_requests
endpoint
last_used_at

Provide usage information in the admin interface.

⸻

13. DATABASE

Create a complete production PostgreSQL schema.

Use internal database IDs as primary keys.

Store external provider IDs separately.

Use:

provider
provider_id

where appropriate.

Use UTC timestamps with:

TIMESTAMPTZ

Use NULL when data is unavailable.

Do NOT convert unavailable values into zero.

Use JSONB for provider-specific/unmodeled information.

⸻

14. REFERENCE TABLES

Create:

countries
competitions
seasons
competition_seasons
competition_season_coverage
venues
competition_rounds

Competition/league records must not be hard-coded only for major leagues.

Support all competitions available through API-Football within the configured import scope.

⸻

15. COMPETITION SEASON COVERAGE

Create:

competition_season_coverage

Track whether each competition/season supports:

events
lineups
fixture statistics
player statistics
standings
players
top scorers
top assists
top cards
injuries
sidelined
predictions
odds

Use these flags to prevent unnecessary API requests.

⸻

16. TEAM DATA

Create:

teams
team_seasons
team_coach_history

Store:

team name
short name
code
country
founded
national flag
logo
venue
provider ID
provider-specific fields

⸻

17. PLAYER DATA

Create:

players
player_team_history
player_match_statistics
player_season_statistics

Support:

player profile
nationality
age/date of birth where available
position
height
weight
team history
transfers
match statistics
season statistics

A player may play for multiple teams in the same season.

Do not assume one player = one team per season.

⸻

18. REFEREE DATA

Create:

referees
referee_match_statistics
referee_season_statistics
referee_competition_statistics

Store:

referee identity
name
nationality where available
provider ID
match assignment
competition
season

Calculate referee statistics locally.

⸻

19. FIXTURES

Create:

fixtures
fixture_periods
fixture_scores

Each fixture must store:

provider fixture ID
competition
season
round
home team
away team
venue
referee
timezone
kickoff time
status
status code
elapsed minutes
postponed flag
home score
away score
half-time score
full-time score
extra-time score
penalty score
provider timestamps
last synchronized time
data hash

Use a unique constraint on:

provider + provider_fixture_id

⸻

20. FIXTURE EVENTS

Create:

fixture_events

Support:

goals
assists
cards
substitutions
penalties
own goals
missed penalties
VAR-related information where available
event minute
extra minute
team
player
assist player
event type
event detail
comments

Do not discard unknown provider event types.

Preserve unknown values in the raw JSON.

⸻

21. MATCH TEAM STATISTICS

Create:

fixture_team_statistics

Support available statistics such as:

shots total
shots on target
shots off target
blocked shots
shots inside box
shots outside box
possession
passes
accurate passes
pass accuracy
corners
offsides
fouls
yellow cards
red cards
goalkeeper saves
expected goals where available
crosses
tackles
interceptions
clearances
blocks
duels
duels won
aerial duels
aerial duels won
dribbles
successful dribbles

Also preserve additional provider fields in JSONB.

⸻

22. PLAYER MATCH STATISTICS

Create:

player_match_statistics

Store:

minutes
rating
position
captain
substitute

goals
assists

shots
shots on target
key passes

passes
accurate passes
pass accuracy

tackles
interceptions
clearances
blocks

duels
duels won

dribbles
successful dribbles

fouls committed
fouls drawn

offsides

yellow cards
red cards

penalties won
penalties committed
penalty goals
penalty misses

goalkeeper saves
goals conceded
clean sheet

expected goals where available
expected assists where available

⸻

23. LINEUPS

Create:

lineups
lineup_players

Store:

formation
coach
starting XI
substitutes
player number
position
captain
substitute status
minutes where available

⸻

24. STANDINGS

Create:

standings
standing_rows

Store:

rank
team
points
played
wins
draws
losses
goals for
goals against
goal difference
form
description

Also store home/away statistics where available.

⸻

25. INJURIES AND AVAILABILITY

Create:

sidelined_records

Support:

injury
suspension
absence type
reason/detail
start date
end date
player
team
competition
season
provider endpoint/source

Do not fabricate missing dates.

⸻

26. TRANSFERS

Create:

transfers

Store:

player
source team
destination team
date
transfer type
loan/permanent information
provider details

Use appropriate uniqueness constraints to prevent duplicates.

⸻

27. ODDS

If odds are available under the account/coverage, support:

bookmakers
odds
odds_values

Store:

bookmaker
market
selection/value
odds
timestamp
fixture
provider data

Keep betting data separate from normal football statistics.

⸻

28. HISTORICAL DATA

Import:

3 completed previous seasons
+
current running season.

Do not assume that every competition has the same available data.

For every competition/season:

1. discover coverage
2. save coverage
3. fetch supported data
4. normalize
5. calculate derived statistics

Historical completed fixtures should be treated as mostly immutable.

Do not repeatedly download unchanged historical data.

⸻

29. CURRENT SEASON

Continuously synchronize:

upcoming fixtures
live fixtures
finished fixtures
standings
events
lineups
player performances
team statistics
injuries
transfers
other supported current-season information

Use different priorities.

⸻

30. LIVE DATA

Create a live synchronization worker.

Process:

1. identify live fixtures
2. detect changed fixtures
3. update score/status
4. update important events
5. fetch detailed information when required
6. update PostgreSQL
7. invalidate/update Redis
8. stop intensive polling when match becomes final

Respect API-Football rate limits.

Never poll every endpoint unnecessarily.

⸻

31. POST-MATCH PIPELINE

When a fixture becomes finished:

1. update final score
2. fetch final events
3. fetch final team statistics
4. fetch player performances
5. fetch lineups
6. update referee statistics
7. update team statistics
8. update player statistics
9. update competition statistics
10. update prediction features
11. invalidate affected cache
12. mark fixture finalized

After a fixture is finalized, do not repeatedly fetch it unless data is missing or changed.

⸻

32. REFEREE ANALYTICS

Calculate for every referee where sufficient data exists:

matches
home wins
draws
away wins

yellow cards
yellow cards per match

second yellow cards

red cards
red cards per match

total cards
cards per match

fouls
fouls per match

penalties
penalties per match

home-team cards
away-team cards

home cards per match
away cards per match

Also calculate:

last 5 matches
last 10 matches
last 20 matches

Calculate competition-specific and season-specific statistics.

These should be derived locally whenever possible.

⸻

33. LEAGUE/COMPETITION ANALYTICS

For every competition + season calculate:

matches
completed matches

goals
goals per match

home goals
away goals

home wins
draws
away wins

BTTS percentage

clean-sheet percentage

failed-to-score percentage

yellow cards
yellow cards per match

second yellow cards

red cards
red cards per match

total cards
cards per match

fouls
fouls per match

penalties
penalties per match

corners
corners per match

shots
shots per match

shots on target
shots on target per match

possession averages where available

expected goals where available

⸻

34. TEAM ANALYTICS

For every team + competition + season calculate:

matches
wins
draws
losses

home matches
home wins
home draws
home losses

away matches
away wins
away draws
away losses

goals for
goals against
goal difference

average goals scored
average goals conceded

clean sheets
failed to score

BTTS

yellow cards
red cards
total cards

fouls
corners

shots
shots on target
possession

expected goals where available

Also calculate:

last 5 form
last 10 form
last 20 form

home form
away form

current streaks where useful.

⸻

35. PLAYER ANALYTICS

Calculate season statistics for every player with available data:

appearances
starts
minutes

goals
assists

shots
shots on target

key passes

passes
accurate passes
pass accuracy

tackles
interceptions
clearances
blocks

duels
duels won

dribbles
successful dribbles

fouls committed
fouls drawn

offsides

yellow cards
red cards

penalties won
penalties committed
penalty goals
penalty misses

goalkeeper saves
goals conceded
clean sheets

expected goals where available
expected assists where available

⸻

36. H2H

Calculate head-to-head statistics locally from stored fixtures.

Do not make external H2H requests if the required fixtures already exist locally.

Calculate:

last 5
last 10
last 20

wins
draws
losses

goals
BTTS
clean sheets
cards
corners
other useful available metrics

⸻

37. RAW API DATA

Create:

raw_provider_payloads

Store important provider responses.

Fields:

provider
endpoint
request parameter hash
entity type
provider entity ID
fixture ID
competition ID
season ID
response JSON
HTTP status
response hash
fetched_at

Never store API keys in raw payloads or request parameters.

The purpose is to allow future reprocessing without calling API-Football again.

⸻

38. PROVIDER REQUEST LOG

Create:

provider_requests

Track:

endpoint
HTTP method
request parameter hash
started_at
completed_at
duration
HTTP status
success
cache hit
daily quota remaining
minute quota remaining
sync task
error information

Never log the API-Football secret.

⸻

39. SYNC ENGINE

Create:

sync_jobs
sync_tasks
sync_state

The system must be:

* restart-safe
* resumable
* idempotent
* quota-aware

Implement:

* retries
* exponential backoff
* retry limits
* failed task handling
* idempotent upserts

A crash must not force the entire import to restart.

⸻

40. REQUEST OPTIMIZATION

Rules:

1. Check Redis first.
2. Check PostgreSQL before external requests.
3. Check competition/season coverage.
4. Batch requests when supported.
5. Avoid downloading unchanged data.
6. Do not repeatedly refresh immutable historical data.
7. Prioritize current/live data.
8. Track provider quota.
9. Respect rate limits.
10. Store raw responses.
11. Recalculate statistics locally whenever possible.

⸻

41. QUOTA MANAGER

Implement a quota manager for approximately:

75,000 requests/day.

Track:

daily limit
daily used
daily remaining
minute limit
minute remaining
last updated

Use thresholds:

NORMAL:
more than 50% remaining

CAUTION:
20–50% remaining

CRITICAL:
less than 20% remaining

When quota is critical:

continue:

* live synchronization
* important score/event updates
* near-term fixtures
* essential post-match processing

Reduce/pause:

* low-priority historical refreshes
* metadata refreshes
* nonessential recalculations requiring provider calls

Do not shut down the entire platform.

⸻

42. REDIS CACHE

Use Redis for:

live fixtures
upcoming fixtures
standings
team statistics
player statistics
referee statistics
competition statistics
prediction features
API responses

Use sensible TTLs.

Invalidate/update cache when database records change.

PostgreSQL remains the source of truth.

⸻

43. OUR REST API

Base:

/api/v1

Create at minimum:

GET /competitions
GET /competitions/:id
GET /competitions/:id/seasons
GET /teams
GET /teams/:id
GET /players
GET /players/:id
GET /referees
GET /referees/:id
GET /fixtures
GET /fixtures/:id
GET /fixtures/upcoming
GET /fixtures/live
GET /fixtures/finished
GET /fixtures/:id/events
GET /fixtures/:id/statistics
GET /fixtures/:id/lineups
GET /fixtures/:id/players
GET /standings
GET /teams/:id/statistics
GET /players/:id/statistics
GET /referees/:id/statistics
GET /competitions/:id/statistics
GET /predictions/features/:fixtureId
GET /health
GET /health/database
GET /health/redis
GET /health/provider
GET /health/data

Use pagination.

Use consistent JSON response structures.

Document everything using OpenAPI/Swagger.

⸻

44. PREDICTION FEATURES

Do not build the prediction model yet unless necessary.

Build reliable features for the prediction application.

For every upcoming fixture calculate:

home recent form
away recent form

home home-form
away away-form

goals scored averages
goals conceded averages

shots averages
shots-on-target averages

possession averages

corners averages

cards averages

fouls averages

clean-sheet rates

failed-to-score rates

BTTS rates

league averages

referee statistics

referee card averages

home/away performance

player availability

injuries/suspensions where available

lineups when available

H2H statistics

The prediction app must retrieve these features from OUR API.

It should not need to calculate raw statistics itself.

⸻

45. PREDICTION API

Provide an endpoint such as:

GET /api/v1/predictions/features/:fixtureId

Return structured information containing:

fixture
competition
home team
away team
recent form
team statistics
home/away statistics
league statistics
referee statistics
player availability
H2H
prediction features
data freshness timestamps

Do not make API-Football calls for every prediction request.

Use local database/cache.

⸻

46. DATA QUALITY

Implement validation.

Examples:

* home team cannot equal away team
* completed fixture must have valid score where applicable
* events must reference valid fixtures
* player statistics must reference valid players
* team statistics must reference valid teams
* referee statistics must reference valid referees
* standings must reference valid competition/season
* provider IDs must not duplicate
* aggregate statistics must be internally consistent

Create:

/api/v1/health/data

that reports data quality status.

⸻

47. DATABASE INDEXES

Create indexes for:

fixtures by competition + season + date
fixtures by team + date
fixtures by status
fixtures by kickoff time

events by fixture
events by team
statistics by fixture
statistics by team
player statistics by player
player statistics by fixture
referee statistics by referee
standings by competition + season
sync tasks by status + priority + scheduled time
provider requests by date
raw payloads by provider/entity/fetched time
API keys by prefix/hash
API usage by client/date

Use database constraints to prevent duplicates.

⸻

48. ADMIN COMMANDS

Create commands/scripts for:

database:migrate
competitions:import
seasons:import
historical:import
current:sync
competition:sync
season:sync
fixture:sync
statistics:recalculate
team:recalculate
player:recalculate
referee:recalculate
league:recalculate
prediction-features:rebuild
cache:rebuild
data-quality:check
quota:status
sync:failed
api-key:create
api-key:rotate
api-key:revoke

These commands must work without manually editing source code.

⸻

49. INITIAL DATA IMPORT

After implementation, actually perform the initial import.

The system must:

1. connect to API-Football
2. verify credentials
3. retrieve competitions
4. retrieve seasons
5. determine three previous seasons + current season
6. save competitions
7. save seasons
8. save coverage
9. import fixtures
10. import teams
11. import players where supported
12. import referees
13. import events
14. import team statistics
15. import player statistics
16. import lineups
17. import standings
18. import injuries/sidelined data
19. import transfers
20. calculate derived statistics
21. calculate referee statistics
22. calculate league statistics
23. calculate team statistics
24. calculate player statistics
25. calculate H2H
26. build prediction features
27. populate Redis
28. run data-quality checks

If the complete import cannot fit into one API quota window, create a resumable queue and automatically continue later.

Never restart the entire import from zero.

⸻

50. CURRENT SEASON AUTOMATION

Set up scheduled background jobs for:

upcoming fixtures
live matches
finished matches
standings
injuries
transfers
player/team updates
statistics recalculation

Use different frequencies according to priority.

Do not use unnecessarily aggressive polling when nothing is happening.

⸻

51. ERROR HANDLING

Handle:

401
403
404
429
500
502
503
504
timeouts
network errors
malformed responses
partial responses

For 429:

* respect rate-limit information
* back off
* reschedule task

For 5xx:

* retry with exponential backoff

For 404:

* do not retry forever

Record errors in the sync system.

⸻

52. SECURITY

Protect:

API-Football key
database password
Redis credentials
JWT/admin secrets
our API keys

Never expose them through:

frontend
API responses
logs
error messages
Git repository

Use secure password hashing/cryptographic methods.

Validate input.

Use parameterized database queries.

Implement API rate limiting.

⸻

53. ADMIN SECURITY

Protect the API-key management interface.

Only authorized administrators may:

* create keys
* revoke keys
* rotate keys
* change scopes
* change rate limits
* manage clients

Do not expose API-key administration through public unauthenticated endpoints.

⸻

54. OBSERVABILITY

Implement structured logs.

Track:

provider requests
provider quota
sync jobs
failed jobs
API requests
API latency
database latency
Redis latency
fixtures synchronized
events synchronized
team statistics
player statistics
referee statistics
standings
prediction features

Create useful health endpoints.

⸻

55. DOCUMENTATION

Create:

README.md
ARCHITECTURE.md
DATABASE.md
SYNC.md
API.md
API_KEYS.md
DEPLOYMENT.md
DATA_DICTIONARY.md
TROUBLESHOOTING.md

Document:

architecture
database relationships
provider endpoints
synchronization
quota management
API endpoints
API-key management
environment variables
deployment
troubleshooting
data limitations

⸻

56. TESTING

Run:

unit tests
database migration tests
integration tests
API tests
provider mapping tests
sync tests
duplicate/idempotency tests
quota tests
Redis tests
API authentication tests
API-key generation tests
API-key revocation tests
API-key rotation tests

Verify:

* duplicate fixture import does not duplicate fixtures
* duplicate events do not duplicate events
* sync resumes after failure
* API works with a valid own API key
* invalid API key is rejected
* revoked API key is rejected
* expired API key is rejected
* insufficient scope is rejected
* rate limiting works
* API-Football key never appears in public responses
* final fixture processing updates derived statistics
* referee statistics are calculated correctly
* league card averages are calculated correctly
* Redis cache works
* database fallback works
* provider quota is tracked

⸻

57. API KEY DELIVERY TO MY APPLICATION

After creating the system, provide a clear way for me to generate the API key for my prediction app.

For example:

Admin Dashboard
    ↓
API Keys
    ↓
Create Client
    ↓
Prediction App
    ↓
Generate API Key
    ↓
pf_live_xxxxxxxxxxxxxxxxx

Also provide a CLI fallback:

npm run api-key:create -- --client "Prediction App"

The command must output the newly generated secret ONCE.

Example:

Client: Prediction App
API Key:
pf_live_xxxxxxxxxxxxxxxxxxxxxxxxx
IMPORTANT:
Save this key now.
It will not be displayed again.

Do not print the secret in normal application logs.

⸻

58. PREDICTION APP CONFIGURATION

Create documentation showing how the prediction app uses our key.

Example:

FOOTBALL_API_BASE_URL=https://api.yourdomain.com/api/v1
FOOTBALL_API_KEY=pf_live_xxxxxxxxx

Example request:

GET /api/v1/predictions/features/12345
X-API-Key: pf_live_xxxxxxxxx

The prediction app must never contain:

API_FOOTBALL_KEY

Only:

FOOTBALL_API_KEY

which is our own API credential.

⸻

59. FINAL SYSTEM ARCHITECTURE

The finished system should operate like this:

                API-FOOTBALL
                     │
              API_FOOTBALL_KEY
                     │
                     ▼
             ┌───────────────┐
             │  SYNC ENGINE  │
             └───────┬───────┘
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   RAW PROVIDER DATA       NORMALIZED DATA
          │                     │
          └──────────┬──────────┘
                     ▼
                PostgreSQL
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
       Team       Player     Referee
      Stats       Stats       Stats
          │          │          │
          └──────────┼──────────┘
                     ▼
              League Analytics
                     │
                     ▼
            Prediction Features
                     │
                     ▼
                   Redis
                     │
                     ▼
              ┌─────────────┐
              │  OUR API    │
              └──────┬──────┘
                     │
                OUR API KEY
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
   Prediction App             Website
---
# 60. DEFINITION OF DONE
Do not report the project as complete merely because code files exist.
The project is complete only when this works end-to-end:
```text
API-Football
      ↓
automatic synchronization
      ↓
PostgreSQL
      ↓
statistics calculation
      ↓
prediction features
      ↓
Redis
      ↓
OUR REST API
      ↓
OUR API KEY AUTHENTICATION
      ↓
Prediction App

The prediction application must be able to retrieve football data from our API without knowing or using the API-Football key.

The website must also use our API.

The platform must be:

* restartable
* resumable
* idempotent
* quota-aware
* secure
* cached
* documented
* tested
* production-ready

⸻

61. FINAL IMPLEMENTATION REPORT

After completing the implementation, provide a concise report containing:

1. project location
2. files created
3. database tables created
4. migrations executed
5. services running
6. API endpoints available
7. admin API-key page location
8. command for generating an API key
9. number of competitions imported
10. number of seasons imported
11. number of teams imported
12. number of players imported
13. number of referees imported
14. number of fixtures imported
15. number of events imported
16. number of team-stat records
17. number of player-stat records
18. number of standings records
19. number of injury/sidelined records
20. number of transfers
21. number of prediction-feature records
22. current API quota status
23. failed synchronization tasks
24. data-quality results
25. known provider coverage limitations
26. commands to start the system
27. commands to generate/revoke/rotate API keys
28. any remaining issues

If a provider endpoint does not provide particular data for a competition/season, explicitly report that limitation.

Never fabricate missing football data.

⸻

62. MOST IMPORTANT INSTRUCTION

Do the work, not just the explanation.

Create it.
Configure it.
Run it.
Test it.
Fetch the data.
Store the data.
Calculate the statistics.
Generate our API keys.
Build the API.
Verify the API.
Verify authentication.
Verify synchronization.
Verify the database.
Verify Redis.
Verify the complete end-to-end pipeline.

When something fails, diagnose it, fix it, rerun the failed step, and continue.

Only stop and ask me when an external secret, credential, infrastructure resource, or genuinely unresolvable decision is required.