//! Leukonet threat registry.
//!
//! Sentinel agents lock a bond to join the swarm. Any sentinel can flag an
//! account by staking NEAR on the claim; other sentinels confirm or dispute it
//! with their own stake. When the report closes, the side that was right takes
//! the stake of the side that was wrong, and confirmed threats land in a public
//! registry that any wallet or agent can query with `is_safe` before paying.

use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

const MAX_EVIDENCE_LEN: usize = 2048;
const MAX_SUMMARY_LEN: usize = 400;
const MAX_PAGE: u64 = 100;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Category {
    /// An account that sweeps victims' balances.
    Drainer,
    /// A full-access key added to an account and used to empty it.
    KeyHijack,
    /// A contract whose code matches known malicious code.
    MaliciousContract,
    /// An agent spending far outside its normal pattern.
    RogueAgent,
    /// A name crafted to imitate a known account.
    Lookalike,
    Other,
}

impl Category {
    fn key(&self) -> &'static str {
        match self {
            Category::Drainer => "drainer",
            Category::KeyHijack => "key_hijack",
            Category::MaliciousContract => "malicious_contract",
            Category::RogueAgent => "rogue_agent",
            Category::Lookalike => "lookalike",
            Category::Other => "other",
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Open,
    Confirmed,
    Rejected,
    /// Closed without enough votes; every stake was refunded.
    Expired,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Vote {
    pub sentinel: AccountId,
    pub support: bool,
    pub stake: NearToken,
    pub note: String,
    pub at_ns: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Report {
    pub id: u64,
    pub target: AccountId,
    pub category: Category,
    /// 1 (suspicious) to 10 (actively stealing funds).
    pub severity: u8,
    pub summary: String,
    /// Machine-readable evidence: transaction hashes, block heights, code hash.
    pub evidence: String,
    pub reporter: AccountId,
    pub created_ns: u64,
    pub deadline_ns: u64,
    pub status: Status,
    pub votes: Vec<Vote>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Sentinel {
    pub account_id: AccountId,
    pub bond: NearToken,
    pub reports_filed: u32,
    pub votes_cast: u32,
    pub correct: u32,
    pub wrong: u32,
    /// Net NEAR won (positive) or lost (negative) on resolved reports, in yoctoNEAR.
    pub earnings: i128,
    pub joined_ns: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Verdict {
    pub account_id: AccountId,
    pub categories: Vec<Category>,
    pub risk: u8,
    pub report_ids: Vec<u64>,
    pub updated_ns: u64,
}

#[near(serializers = [json])]
pub struct SafetyCheck {
    pub account_id: AccountId,
    pub safe: bool,
    /// 0 (no known issues) to 100 (confirmed active threat).
    pub risk: u8,
    pub categories: Vec<Category>,
    pub report_ids: Vec<u64>,
    /// Open reports that have not been decided yet.
    pub pending_reports: Vec<u64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Config {
    pub min_bond: NearToken,
    pub min_stake: NearToken,
    /// Votes (including the reporter's) needed for a decision.
    pub quorum: u32,
    pub window_ns: u64,
    /// Share of staked NEAR (in percent) that must support a report to confirm it.
    pub confirm_pct: u8,
}

#[near(serializers = [json])]
pub struct Stats {
    pub sentinels: u32,
    pub reports: u64,
    pub open: u64,
    pub confirmed: u64,
    pub rejected: u64,
    pub flagged_accounts: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner: AccountId,
    config: Config,
    sentinels: IterableMap<AccountId, Sentinel>,
    reports: Vector<Report>,
    /// "target|category" -> id of the open report for that pair.
    open_by_key: LookupMap<String, u64>,
    /// account -> ids of its open reports.
    pending: LookupMap<AccountId, Vec<u64>>,
    verdicts: IterableMap<AccountId, Verdict>,
    confirmed: u64,
    rejected: u64,
    open: u64,
}

/// `pool * part / whole` without overflowing u128. Works in units of 1e9
/// yoctoNEAR; the rounding dust (well under a millionth of a NEAR) stays in the contract.
fn share(pool: u128, part: u128, whole: u128) -> u128 {
    const UNIT: u128 = 1_000_000_000;
    let w = whole / UNIT;
    if w == 0 {
        return 0;
    }
    (pool / UNIT) * (part / UNIT) / w * UNIT
}

fn open_key(target: &AccountId, category: Category) -> String {
    format!("{}|{}", target, category.key())
}

#[near]
impl Registry {
    #[init]
    pub fn new(owner: AccountId, config: Option<Config>) -> Self {
        Self {
            owner,
            config: config.unwrap_or(Config {
                min_bond: NearToken::from_millinear(500),
                min_stake: NearToken::from_millinear(50),
                quorum: 3,
                window_ns: 20_000_000_000,
                confirm_pct: 66,
            }),
            sentinels: IterableMap::new(b"s"),
            reports: Vector::new(b"r"),
            open_by_key: LookupMap::new(b"o"),
            pending: LookupMap::new(b"p"),
            verdicts: IterableMap::new(b"v"),
            confirmed: 0,
            rejected: 0,
            open: 0,
        }
    }

    // ----- sentinels -------------------------------------------------------

    /// Join the swarm by locking a bond. Calling again tops the bond up.
    #[payable]
    pub fn register_sentinel(&mut self) -> Sentinel {
        let who = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        let sentinel = match self.sentinels.get(&who) {
            Some(s) => Sentinel { bond: s.bond.saturating_add(deposit), ..s.clone() },
            None => {
                require!(deposit >= self.config.min_bond, "Bond is below the minimum");
                Sentinel {
                    account_id: who.clone(),
                    bond: deposit,
                    reports_filed: 0,
                    votes_cast: 0,
                    correct: 0,
                    wrong: 0,
                    earnings: 0,
                    joined_ns: env::block_timestamp(),
                }
            }
        };
        self.sentinels.insert(who, sentinel.clone());
        env::log_str(&format!("EVENT_JSON:{{\"event\":\"sentinel_joined\",\"sentinel\":\"{}\"}}", sentinel.account_id));
        sentinel
    }

    // ----- reports ---------------------------------------------------------

    /// Flag an account. If an open report already exists for this account and
    /// category, the call counts as a supporting vote on it instead.
    #[payable]
    pub fn flag(
        &mut self,
        target: AccountId,
        category: Category,
        severity: u8,
        summary: String,
        evidence: String,
    ) -> u64 {
        let who = self.require_sentinel();
        let stake = env::attached_deposit();
        require!(stake >= self.config.min_stake, "Stake is below the minimum");
        require!((1..=10).contains(&severity), "Severity must be 1-10");
        require!(summary.len() <= MAX_SUMMARY_LEN, "Summary too long");
        require!(evidence.len() <= MAX_EVIDENCE_LEN, "Evidence too long");
        require!(target != who, "Sentinels cannot flag themselves");

        let key = open_key(&target, category);
        if let Some(id) = self.open_by_key.get(&key).copied() {
            self.add_vote(id, who, true, summary, stake);
            return id;
        }

        let now = env::block_timestamp();
        let id = self.reports.len() as u64;
        let report = Report {
            id,
            target: target.clone(),
            category,
            severity,
            summary,
            evidence,
            reporter: who.clone(),
            created_ns: now,
            deadline_ns: now + self.config.window_ns,
            status: Status::Open,
            votes: vec![Vote { sentinel: who.clone(), support: true, stake, note: "reporter".into(), at_ns: now }],
        };
        self.reports.push(report);
        self.open_by_key.insert(key, id);
        let mut p = self.pending.get(&target).cloned().unwrap_or_default();
        p.push(id);
        self.pending.insert(target.clone(), p);
        self.open += 1;
        if let Some(s) = self.sentinels.get_mut(&who) {
            s.reports_filed += 1;
        }
        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"flagged\",\"report\":{},\"target\":\"{}\",\"category\":\"{}\",\"reporter\":\"{}\"}}",
            id, target, category.key(), who
        ));
        id
    }

    /// Confirm (`support = true`) or dispute an open report, staking NEAR on the call.
    #[payable]
    pub fn vote(&mut self, report_id: u64, support: bool, note: Option<String>) {
        let who = self.require_sentinel();
        let stake = env::attached_deposit();
        require!(stake >= self.config.min_stake, "Stake is below the minimum");
        let note = note.unwrap_or_default();
        require!(note.len() <= MAX_SUMMARY_LEN, "Note too long");
        self.add_vote(report_id, who, support, note, stake);
    }

    /// Close a report. Anyone can call this once the window has passed, or as
    /// soon as the quorum has voted unanimously.
    pub fn finalize(&mut self, report_id: u64) -> Status {
        let now = env::block_timestamp();
        let cfg = self.config.clone();
        let report = self.reports.get_mut(report_id as u32).unwrap_or_else(|| env::panic_str("No such report"));
        require!(report.status == Status::Open, "Report is already closed");

        let quorum = cfg.quorum as usize;
        let unanimous = report.votes.iter().all(|v| v.support == report.votes[0].support);
        require!(
            now >= report.deadline_ns || (report.votes.len() >= quorum && unanimous),
            "Voting window still open"
        );

        let support: u128 = report.votes.iter().filter(|v| v.support).map(|v| v.stake.as_yoctonear()).sum();
        let against: u128 = report.votes.iter().filter(|v| !v.support).map(|v| v.stake.as_yoctonear()).sum();
        let total = support + against;

        let status = if report.votes.len() < quorum {
            Status::Expired
        } else if support * 100 >= total * cfg.confirm_pct as u128 {
            Status::Confirmed
        } else {
            Status::Rejected
        };
        report.status = status;
        let report = report.clone();

        // Pay out: refunds on expiry, otherwise winners split the losers' stake pro rata.
        let (win_pool, lose_pool) = match status {
            Status::Confirmed => (support, against),
            Status::Rejected => (against, support),
            _ => (total, 0),
        };
        for v in &report.votes {
            let won = match status {
                Status::Confirmed => v.support,
                Status::Rejected => !v.support,
                _ => true,
            };
            let stake = v.stake.as_yoctonear();
            let payout = if won && win_pool > 0 { stake + share(lose_pool, stake, win_pool) } else { 0 };
            if payout > 0 {
                let _ = Promise::new(v.sentinel.clone()).transfer(NearToken::from_yoctonear(payout));
            }
            if let Some(s) = self.sentinels.get_mut(&v.sentinel) {
                if status != Status::Expired {
                    if won { s.correct += 1 } else { s.wrong += 1 }
                    s.earnings += payout as i128 - stake as i128;
                }
            }
        }

        self.open_by_key.remove(&open_key(&report.target, report.category));
        if let Some(p) = self.pending.get_mut(&report.target) {
            p.retain(|id| *id != report_id);
        }
        self.open -= 1;

        match status {
            Status::Confirmed => {
                self.confirmed += 1;
                let mut v = self.verdicts.get(&report.target).cloned().unwrap_or(Verdict {
                    account_id: report.target.clone(),
                    categories: vec![],
                    risk: 0,
                    report_ids: vec![],
                    updated_ns: now,
                });
                if !v.categories.contains(&report.category) {
                    v.categories.push(report.category);
                }
                v.report_ids.push(report_id);
                v.risk = v.risk.max(report.severity * 10);
                v.updated_ns = now;
                self.verdicts.insert(report.target.clone(), v);
            }
            Status::Rejected => self.rejected += 1,
            _ => {}
        }

        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"finalized\",\"report\":{},\"target\":\"{}\",\"status\":\"{:?}\"}}",
            report_id, report.target, status
        ));
        status
    }

    /// Owner override for a proven false positive.
    pub fn clear_verdict(&mut self, account_id: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "Only the owner can clear verdicts");
        self.verdicts.remove(&account_id);
    }

    pub fn set_config(&mut self, config: Config) {
        require!(env::predecessor_account_id() == self.owner, "Only the owner can change config");
        require!(config.quorum >= 1 && config.confirm_pct > 50 && config.confirm_pct <= 100, "Invalid config");
        self.config = config;
    }

    // ----- views -----------------------------------------------------------

    /// The call wallets and agents make before sending money.
    pub fn is_safe(&self, account_id: AccountId) -> SafetyCheck {
        let pending = self.pending.get(&account_id).cloned().unwrap_or_default();
        match self.verdicts.get(&account_id) {
            Some(v) => SafetyCheck {
                account_id,
                safe: false,
                risk: v.risk,
                categories: v.categories.clone(),
                report_ids: v.report_ids.clone(),
                pending_reports: pending,
            },
            None => SafetyCheck {
                account_id,
                safe: true,
                risk: if pending.is_empty() { 0 } else { 20 },
                categories: vec![],
                report_ids: vec![],
                pending_reports: pending,
            },
        }
    }

    pub fn get_report(&self, report_id: u64) -> Option<Report> {
        self.reports.get(report_id as u32).cloned()
    }

    /// Newest first.
    pub fn get_reports(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Report> {
        let len = self.reports.len() as u64;
        let skip = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(20).min(MAX_PAGE);
        (0..len)
            .rev()
            .skip(skip as usize)
            .take(limit as usize)
            .filter_map(|i| self.reports.get(i as u32).cloned())
            .collect()
    }

    pub fn get_sentinels(&self) -> Vec<Sentinel> {
        self.sentinels.values().cloned().collect()
    }

    pub fn get_verdicts(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Verdict> {
        self.verdicts
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(MAX_PAGE) as usize)
            .cloned()
            .collect()
    }

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_stats(&self) -> Stats {
        Stats {
            sentinels: self.sentinels.len(),
            reports: self.reports.len() as u64,
            open: self.open,
            confirmed: self.confirmed,
            rejected: self.rejected,
            flagged_accounts: self.verdicts.len(),
        }
    }

    // ----- internal --------------------------------------------------------

    fn require_sentinel(&self) -> AccountId {
        let who = env::predecessor_account_id();
        require!(self.sentinels.contains_key(&who), "Only registered sentinels can do this");
        who
    }

    fn add_vote(&mut self, id: u64, who: AccountId, support: bool, note: String, stake: NearToken) {
        let now = env::block_timestamp();
        let report = self.reports.get_mut(id as u32).unwrap_or_else(|| env::panic_str("No such report"));
        require!(report.status == Status::Open, "Report is closed");
        require!(now < report.deadline_ns, "Voting window has ended");
        require!(report.target != who, "Sentinels cannot vote on reports about themselves");
        require!(!report.votes.iter().any(|v| v.sentinel == who), "Already voted on this report");
        report.votes.push(Vote { sentinel: who.clone(), support, stake, note, at_ns: now });
        if let Some(s) = self.sentinels.get_mut(&who) {
            s.votes_cast += 1;
        }
        env::log_str(&format!(
            "EVENT_JSON:{{\"event\":\"voted\",\"report\":{},\"sentinel\":\"{}\",\"support\":{}}}",
            id, who, support
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(who: &str, deposit_milli: u128, ts_s: u64) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(acc(who))
            .attached_deposit(NearToken::from_millinear(deposit_milli))
            .block_timestamp(ts_s * 1_000_000_000);
        testing_env!(b.build());
    }

    fn setup() -> Registry {
        ctx("owner.testnet", 0, 0);
        let mut r = Registry::new(acc("owner.testnet"), None);
        for s in ["s1.testnet", "s2.testnet", "s3.testnet", "s4.testnet"] {
            ctx(s, 500, 0);
            r.register_sentinel();
        }
        r
    }

    #[test]
    fn unanimous_quorum_confirms_and_blocks_target() {
        let mut r = setup();
        ctx("s1.testnet", 100, 1);
        let id = r.flag(acc("thief.testnet"), Category::Drainer, 9, "sweeps victims".into(), "tx:abc".into());
        assert!(r.is_safe(acc("thief.testnet")).safe);
        assert_eq!(r.is_safe(acc("thief.testnet")).pending_reports, vec![id]);
        ctx("s2.testnet", 100, 2);
        r.vote(id, true, None);
        ctx("s3.testnet", 100, 3);
        // flagging the same target+category again joins the open report
        assert_eq!(r.flag(acc("thief.testnet"), Category::Drainer, 9, "same".into(), "".into()), id);
        ctx("anyone.testnet", 0, 4);
        assert_eq!(r.finalize(id), Status::Confirmed);
        let check = r.is_safe(acc("thief.testnet"));
        assert!(!check.safe);
        assert_eq!(check.risk, 90);
        assert_eq!(check.categories, vec![Category::Drainer]);
        assert!(check.pending_reports.is_empty());
        assert_eq!(r.get_stats().confirmed, 1);
        assert!(get_logs().iter().any(|l| l.contains("finalized")));
    }

    #[test]
    fn disputed_report_is_rejected_and_reporter_loses_stake() {
        let mut r = setup();
        ctx("s1.testnet", 100, 1);
        let id = r.flag(acc("honest.testnet"), Category::RogueAgent, 5, "odd".into(), "".into());
        ctx("s2.testnet", 100, 2);
        r.vote(id, false, Some("normal payroll run".into()));
        ctx("s3.testnet", 200, 3);
        r.vote(id, false, None);
        ctx("anyone.testnet", 0, 30);
        assert_eq!(r.finalize(id), Status::Rejected);
        assert!(r.is_safe(acc("honest.testnet")).safe);
        let s = r.get_sentinels();
        let s1 = s.iter().find(|x| x.account_id == acc("s1.testnet")).unwrap();
        let s3 = s.iter().find(|x| x.account_id == acc("s3.testnet")).unwrap();
        assert_eq!(s1.wrong, 1);
        assert_eq!(s1.earnings, -(NearToken::from_millinear(100).as_yoctonear() as i128));
        // s3 staked 2/3 of the winning side, so wins 2/3 of the 0.1 NEAR lost
        let expected = (NearToken::from_millinear(100).as_yoctonear() * 2 / 3) as i128;
        assert!((s3.earnings - expected).abs() < 1_000_000_000_000_000, "got {}", s3.earnings);
    }

    #[test]
    fn too_few_votes_expire_with_refunds() {
        let mut r = setup();
        ctx("s1.testnet", 100, 1);
        let id = r.flag(acc("maybe.testnet"), Category::Lookalike, 4, "".into(), "".into());
        ctx("anyone.testnet", 0, 30);
        assert_eq!(r.finalize(id), Status::Expired);
        assert!(r.is_safe(acc("maybe.testnet")).safe);
        assert_eq!(r.get_sentinels()[0].earnings, 0);
    }

    #[test]
    #[should_panic(expected = "Voting window still open")]
    fn cannot_finalize_early_without_quorum() {
        let mut r = setup();
        ctx("s1.testnet", 100, 1);
        let id = r.flag(acc("x.testnet"), Category::Other, 3, "".into(), "".into());
        r.finalize(id);
    }

    #[test]
    #[should_panic(expected = "Already voted")]
    fn no_double_votes() {
        let mut r = setup();
        ctx("s1.testnet", 100, 1);
        let id = r.flag(acc("x.testnet"), Category::Other, 3, "".into(), "".into());
        r.vote(id, true, None);
    }

    #[test]
    #[should_panic(expected = "Only registered sentinels")]
    fn outsiders_cannot_flag() {
        let mut r = setup();
        ctx("rando.testnet", 100, 1);
        r.flag(acc("x.testnet"), Category::Other, 3, "".into(), "".into());
    }

    #[test]
    fn reports_list_newest_first() {
        let mut r = setup();
        ctx("s1.testnet", 100, 1);
        r.flag(acc("a.testnet"), Category::Other, 3, "".into(), "".into());
        r.flag(acc("b.testnet"), Category::Other, 3, "".into(), "".into());
        let list = r.get_reports(None, None);
        assert_eq!(list[0].target, acc("b.testnet"));
        assert_eq!(list.len(), 2);
    }
}
