import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Developer } from './Developer';

@Entity('apis')
export class Api {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  developer_id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @ManyToOne(() => Developer, (developer) => developer.apis)
  @JoinColumn({ name: 'developer_id' })
  developer!: Developer;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
