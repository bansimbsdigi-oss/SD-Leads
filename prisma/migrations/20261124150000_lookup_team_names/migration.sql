-- Lead lookup: team letters in the Mentor sheet (A, B, …) → mentor names; a closed team is never routed to.

-- AlterTable
ALTER TABLE "lookup_configs" ADD COLUMN     "team_names" TEXT NOT NULL DEFAULT 'A = Anupa
B = Varsha
C = Jesal
D = closed
E = Poonam
F = Shobhita
G = Sweety';

