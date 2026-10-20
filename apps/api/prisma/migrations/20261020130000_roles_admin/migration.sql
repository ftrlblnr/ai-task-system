-- Владелец 20.10.2026: роль «Администратор»; флаги isProfileAdmin (заменён
-- ролью ADMIN) и canCreateTrips (поездки создают все) больше не нужны.
ALTER TYPE "Role" ADD VALUE 'ADMIN';

ALTER TABLE "Employee" DROP COLUMN "isProfileAdmin",
DROP COLUMN "canCreateTrips";
