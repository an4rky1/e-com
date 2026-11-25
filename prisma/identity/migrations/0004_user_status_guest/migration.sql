-- identity: the guest placeholder joins the user vocabulary.
--
-- Additive only: an existing default (`pending_verification`) stays a member, so no
-- default juggling is needed the way `0001_enums` needed it when the column was text.

ALTER TYPE "UserStatus" ADD VALUE 'guest';
