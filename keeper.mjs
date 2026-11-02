// Firefly Lab brightness keeper: writes each minter's brightness into FireflyReward.
// Runs on a schedule (GitHub Actions). Signs with KEEPER_KEY, the owner of FireflyReward.
import { ethers } from "ethers";
import fs from "node:fs";

const RPCS = (process.env.BSC_RPC || "https://bsc-dataseed1.binance.org,https://bsc-dataseed2.binance.org,https://bsc-dataseed.bnbchain.org,https://bsc-rpc.publicnode.com").split(",");
const SALE = "0xdc9BC10749ddCb6fD2f9898C4fF6Fc6731D296e9";
const REWARD = "0x239da8690dA5a5dc6314b7C94901d8Af6Bf2a65B";
const TOKEN = "0x1fB022a8299903524917341e3B8fa7474433E1e0";
const LOG_RPCS = (process.env.BSC_LOG_RPC || "https://bsc-rpc.publicnode.com,https://bsc.drpc.org").split(",");
const START_BLOCK = 131251400;      // Sale deployed at block 131251493 (2026-11-02 21:47 CST)
const CHUNK = 1000;                 // public BSC nodes cap getLogs ranges
const MAX_TX = +(process.env.MAX_TX || 300);
const DRY = process.env.DRY_RUN === "1";
const STATE = "state.json";

const saleAbi = [
  "event Minted(address indexed user, uint256 tier, uint256 shares, uint256 lumenAmount)",
  "function vestedTotal(address) view returns (uint256)",
  "function vestedClaimed(address) view returns (uint256)",
  "function totalMinted(address) view returns (uint256)",
];
const rewardAbi = [
  "function owner() view returns (address)",
  "function brightness(address) view returns (uint256)",
  "function updateBrightness(address user, uint256 lumenHeld)",
];
const tokenAbi = ["function balanceOf(address) view returns (uint256)"];

// hold-time multiplier x10, per the whitepaper: <3d 1x, 3-7d 1.2x, 7-30d 1.5x, 30d+ 2x
function mult10(heldSec) {
  const d = heldSec / 86400;
  return d < 3 ? 10n : d < 7 ? 12n : d < 30 ? 15n : 20n;
}

async function getLogs(filter) {
  let last;
  for (const url of LOG_RPCS) {
    try { return await new ethers.JsonRpcProvider(url, 56, { staticNetwork: true }).getLogs(filter); } catch (e) { last = e; }
  }
  throw last;
}

async function provider() {
  for (const url of RPCS) {
    try { const p = new ethers.JsonRpcProvider(url, 56, { staticNetwork: true }); await p.getBlockNumber(); return p; } catch {}
  }
  throw new Error("no BSC RPC reachable");
}

async function main() {
  const p = await provider();
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { lastBlock: START_BLOCK - 1, wallets: {} };
  const sale = new ethers.Contract(SALE, saleAbi, p);
  const token = new ethers.Contract(TOKEN, tokenAbi, p);

  // 1. scan new Minted events
  const head = (await p.getBlockNumber()) - 3;
  const topic = sale.interface.getEvent("Minted").topicHash;
  const tsCache = {};
  for (let from = state.lastBlock + 1; from <= head; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, head);
    const logs = await getLogs({ address: SALE, topics: [topic], fromBlock: from, toBlock: to });
    for (const l of logs) {
      const ev = sale.interface.parseLog(l);
      const a = ev.args.user.toLowerCase();
      tsCache[l.blockNumber] ??= (await p.getBlock(l.blockNumber)).timestamp;
      const w = (state.wallets[a] ??= { minted: "0", shares: 0, first: tsCache[l.blockNumber], fb: l.blockNumber, fi: l.index });
      w.minted = (BigInt(w.minted) + ev.args.lumenAmount).toString();
      w.shares = (w.shares || 0) + Number(ev.args.shares);
    }
    state.lastBlock = to;
  }
  for (const [a, w] of Object.entries(state.wallets)) w.shares = Number(await sale.totalMinted(a));
  console.log(`scanned to ${state.lastBlock}, ${Object.keys(state.wallets).length} minting wallets`);

  // 2. compute target brightness and push the ones that changed
  const key = process.env.KEEPER_KEY;
  const signer = key ? new ethers.Wallet(key, p) : null;
  const reward = new ethers.Contract(REWARD, rewardAbi, signer || p);
  if (signer && !DRY) {
    const owner = (await reward.owner()).toLowerCase();
    if (owner !== signer.address.toLowerCase()) throw new Error(`KEEPER_KEY ${signer.address} is not the FireflyReward owner (${owner})`);
  }
  const now = Math.floor(Date.now() / 1000);
  let sent = 0;
  for (const [a, w] of Object.entries(state.wallets)) {
    if (sent >= MAX_TX) { console.log("MAX_TX reached, rest next run"); break; }
    const [bal, vt, vc, cur] = await Promise.all([token.balanceOf(a), sale.vestedTotal(a), sale.vestedClaimed(a), reward.brightness(a)]);
    let held = bal + (vt > vc ? vt - vc : 0n);          // wallet balance + still-vesting mint
    const minted = BigInt(w.minted);
    if (held > minted) held = minted;                    // DEX buys don't count
    const m = mult10(now - w.first);
    const target = held * m / 10n;                       // brightness we want on chain
    // contract stores lumenHeld * stageMultiplier; stageStart is never set, so its multiplier is always 2x
    const arg = held * m / 20n;
    const diff = target > cur ? target - cur : cur - target;
    if (diff === 0n || (cur > 0n && diff * 100n < cur && target > 0n)) continue; // skip <1% drift
    console.log(`${a}: ${ethers.formatEther(cur)} -> ${ethers.formatEther(target)} (x${Number(m) / 10})`);
    if (!signer || DRY) continue;
    const tx = await reward.updateBrightness(a, arg);
    await tx.wait();
    sent++;
  }
  console.log(`updates sent: ${sent}`);
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
