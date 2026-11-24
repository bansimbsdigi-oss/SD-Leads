-- Lead lookup: the team list becomes a directory of teams (mentor, phone, email, closed) and
-- sub-mentors (name, team, phone, email). The old team text was the default list, which is the new default.
-- AlterTable
ALTER TABLE "lookup_configs" DROP COLUMN "team_names",
ADD COLUMN     "sub_mentors" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "teams" JSONB NOT NULL DEFAULT '[{"code":"A","mentor":"Anupa","phone":"0000000000","email":"","closed":false},{"code":"B","mentor":"Varsha","phone":"0000000000","email":"","closed":false},{"code":"C","mentor":"Jesal","phone":"0000000000","email":"","closed":false},{"code":"D","mentor":"","phone":"","email":"","closed":true},{"code":"E","mentor":"Poonam","phone":"0000000000","email":"","closed":false},{"code":"F","mentor":"Shobhita","phone":"0000000000","email":"","closed":false},{"code":"G","mentor":"Sweety","phone":"0000000000","email":"","closed":false}]';

