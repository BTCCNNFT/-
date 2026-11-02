# Firefly Lab brightness keeper

Every hour this reads `Minted` events from FireflySale, works out each minter's eligible $LUMEN
(wallet balance + unvested mint, capped at what they minted, so DEX buys don't count) and hold-time
multiplier (<3d 1x, 3-7d 1.2x, 7-30d 1.5x, 30d+ 2x), then calls `FireflyReward.updateBrightness`
for wallets whose brightness changed by 1% or more.

Setup: Settings -> Secrets and variables -> Actions -> New repository secret, name `KEEPER_KEY`,
value = private key of the FireflyReward owner wallet (keep only a little BNB for gas in it).
Without the secret it runs read-only and just logs what it would change.
