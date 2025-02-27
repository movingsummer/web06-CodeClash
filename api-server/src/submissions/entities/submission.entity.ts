import { BaseTable } from 'src/common/entities/base-table.entity';
import { ProblemTable } from 'src/problems/entities/problem.entity';
import { UserTable } from 'src/users/entities/user.entity';
import { Column, Entity, ManyToOne } from 'typeorm';

@Entity({ name: 'submission' })
export class SubmissionTable extends BaseTable {
  @Column()
  language: string;

  @Column({ type: 'text' })
  code: string;

  @Column({ type: 'text' })
  status: string;

  @ManyToOne(() => UserTable, (user) => user.submissions)
  user: UserTable;

  @ManyToOne(() => ProblemTable, (problem) => problem.submissions)
  problem: ProblemTable;
}
