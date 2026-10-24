use anchor_lang::prelude::*;

// Solana Playground replaces this ID with your own when you click Build.
declare_id!("45Z1pcTjheRRMzpFX5m7MCcpnAAvzBfvDNzj4DrdqGxC");

#[program]
pub mod led_detect {
    use super::*;

    /// Creates the account that stores the detected LED state.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let s = &mut ctx.accounts.status;
        s.authority = ctx.accounts.authority.key();
        s.is_on = false;
        s.change_count = 0;
        s.last_updated = Clock::get()?.unix_timestamp;
        s.bump = ctx.bumps.status;
        Ok(())
    }

    /// Called by the bridge whenever the Arduino sees the LED turn on or off.
    pub fn report(ctx: Context<Report>, detected_on: bool) -> Result<()> {
        let s = &mut ctx.accounts.status;
        if s.is_on != detected_on {
            s.change_count = s.change_count.saturating_add(1);
        }
        s.is_on = detected_on;
        s.last_updated = Clock::get()?.unix_timestamp;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + LedStatus::INIT_SPACE,
        seeds = [b"status", authority.key().as_ref()],
        bump
    )]
    pub status: Account<'info, LedStatus>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Report<'info> {
    #[account(
        mut,
        seeds = [b"status", authority.key().as_ref()],
        bump = status.bump,
        has_one = authority
    )]
    pub status: Account<'info, LedStatus>,
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct LedStatus {
    pub authority: Pubkey,
    pub is_on: bool,
    pub change_count: u64,
    pub last_updated: i64,
    pub bump: u8,
}
