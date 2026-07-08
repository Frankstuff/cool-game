You are a very helpful assistant who implements the low level details and placeholders where needed. For architectual decisions you consult me and explain what you plan to do before doing it. This is meant to be a game like the old .io games with a pretty big map and areas of the map that spawn different things. This file has an outline of what the game should play like. Not sure what the best architecture is but probably a central server which has the game state of each player and idk really how we prevent cheating . . . but it is meant to be a multi player game  . . . maybe implement multiplayer functionality before we move onto the mechanics and stuff???Core Fantasy: Blue Team players focus on improving their stats and forming strong connections with Red Team players while avoiding Green Team players. Red Team players aim to dominate the map and maintain strong alliances. Green Team players act as disruptors trying to interfere with others.
Team Ratio (Auto-balanced):
1 Red : 9 Green : 3 Blue
Scoring Systems

Growth Orbs (scattered across the map): Everyone can collect them.
Red: 2x points
Blue: 1x points
Green: 0.5x points (until upgraded)

Linking: Major point opportunities, especially for Blue. Unequal boosts after successful linking.
Additional scoring: Rejection penalties, survival time, PvP victories, and upgrades.

Player Stats (Visible & Upgradable):

Height
Face
Strength
Attractiveness (main score multiplier)
Personality (purely cosmetic/joke stat — does almost nothing)

Detailed Class Mechanics
Blue Team (Strategic & Mobile Playstyle)

Start small and fast. Grow by collecting orbs and successful linking.
Primary Goal: Improve stats → Form connections with high-stat Red players → Survive and outscore others.
Ability: Dash Burst – short speed boost + stun on nearby Green players.
Ultimate: Beacon Mode – become a glowing beacon that attracts nearby Red players.
Linking Mechanic: Move into a Red player → Request link. Red has 3 seconds to accept.
Success = big points for Blue, smaller boost for Red. Both receive temporary speed/attraction buffs (unequal).
Long cooldown prevents permanent pairing.

PvP: Blue players can compete with other Blue players (steal orbs or disrupt links).
Weakness: Green player touch applies Slow Debuff (slow + shrink over time).
Tiers: Visual upgrades that evolve with stat improvements.

Red Team (Rare & Dominant)

Start bigger and stronger.
Primary Goal: Farm orbs for high score, form and maintain alliances with Blue players, compete with rival Red players.
Ability: Aura Shield – passively attracts Blue players + repels weak Green players.
Linking: Must accept or deny requests within 3 seconds. Rejection gives small status boost but risks score penalty.
Linking Reward: Temporary boost that helps pull other Blue players toward them.
PvP: Red players can fight each other for dominance.
Risk: Can be overwhelmed by large groups of Green players.

Green Team (Disruptor – Most Common)

Start small and numerous, weak individually.
Primary Goal: Disrupt Blue players, gang up on Red players, and upgrade into stronger units.
Ability: Trail Debuff – leaves slowing trails that affect Blue players.
Ultimate: Rage Mode – temporary massive size and aggression.
Upgrade Zones (special map areas):
Leg Enhancement Surgery
Facial Enhancement Surgery
→ Transforms Green into a stronger Red-like unit with improved stats.

Mythic Item: Charisma Surge – rare spawn that instantly transforms a Green player into a high-stat Red unit.
Tools: Collect map weapons and abilities. Rely on numbers or special gear.
Boosters: Temporary strength items (Frenzy Mode) for combat.

Map & World Features

Large endless-feeling arena with a competitive society aesthetic.
Floating elements: motivational posters, resource icons, and humorous quotes.
Gym Areas: High orb spawn zones that give bonus growth but attract heavy competition.
Wage Cage Areas: Draining zones that slowly reduce score over time if players stay too long — forces movement and risk/reward decisions.
Upgrade clinics as risky safe zones for Green players.
Random events and power-up spawns.

Anti-Teaming & Balance

Long linking cooldowns prevent permanent alliances.
Rejection risk discourages blind loyalty.
Natural counters through team numbers and upgrade paths.

Global Leaderboards

All-Time & Daily/Weekly rankings with multiple categories:
Highest Total Score
Most Successful Links
Longest Survival Time
Most Growth Orbs Collected
Most Disruptions (Green-focused)
Highest Arena Dominance


Visual & Theme Style

Top-down pixel / bright meme art style (old Flash games + modern .io polish).
Teams use distinct color-coded visuals: Red (strong/dominant look), Blue (stylish/mobile look), Green (disruptive/edgy variants).
Humorous death animations and floating text.

---

## Implementation Status

Terminology: internal enums stay `red/green/blue`; all player-facing text uses
Chad / Foid / Chud etc. via the `NAMES` map in `shared/constants.js`.

Architecture: authoritative Node + `ws` server (20 Hz sim, clients send only
input intents → anti-cheat), Canvas client. Tests: `node --test` (38 passing).

- [x] Multiplayer, central authoritative server (`server/`), shared world
- [x] Auto-balanced team ratio 1 Chad : 9 Chud : 3 Foid (`pickTeam`)
- [x] Looksmaxx Orbs, per-team multipliers (Chad 2x / Foid 1x / Chud 0.5x→1x upgraded), kept scarce
- [x] Mating (link): request → 3s accept, unequal rewards + buffs, long cooldown
- [x] Rejection penalty/boost, survival time, PvP victories, upgrade scoring
- [x] Stats: Height/Face/Strength/Attractiveness (main multiplier)/Personality (joke)
- [x] Foid: Dash Burst, Hypergamy Mode ultimate, mobility, Chud-touch Blackpill Debuff (slow+shrink), tiers
- [x] Chad: Chad Aura (attract Foid / repel weak Chud), accept/deny mating, PvP
- [x] Chud: Blackpill Spray trail, Inceldot rage ultimate, numbers
- [x] Upgrade zones: Leg Lengthening Surgery / Face Surgery → Chud becomes Chad
- [x] Mythic Personality Surgery: instant Chud → high-stat Chad
- [x] Tools/weapons: fists (Chad stronger) + pickup Blaster; health bars & damage
- [x] Boosters: Roid Rage (Frenzy) pickup → temp damage + speed
- [x] Map: large arena, Gym (dense orbs), Wage Cage (score drain), clinics, minimap
- [x] Floating decorative posters/quotes + humorous death floating text
- [x] Random spawns: orbs, weapon crates, boosters, mythic
- [x] Anti-teaming: long mating cooldown, rejection risk
- [x] Global leaderboards: 6 categories, All-Time / Daily / Weekly windows (disk-persisted)
- [x] Color-coded top-down visuals; sprite drop-in via `public/assets/` + `manifest.js`
- [x] Deployment: Dockerfile + fly.toml (single always-on machine)
