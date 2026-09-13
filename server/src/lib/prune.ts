/** Helpers for retention loops: cutoffs, and deletes in batches so one pass never holds a huge DELETE. */
import {
  type Attributes,
  type Model,
  type ModelStatic,
  Op,
  type Sequelize,
  type WhereOptions,
} from "sequelize";

/** The instant before which rows expire, or null when `days` is 0 (keep forever). */
export function cutoff(days: number, now = Date.now()): Date | null {
  return days > 0 ? new Date(now - days * 86_400_000) : null;
}

/**
 * Delete matching rows `batch` ids at a time, oldest first, until none are left. Foreign keys
 * cascade per batch (a job takes its runs and output with it), which keeps each statement short.
 */
export async function destroyInBatches<M extends Model>(
  model: ModelStatic<M>,
  where: WhereOptions<Attributes<M>>,
  batch = 500,
): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await model.findAll({
      attributes: ["id"],
      where,
      order: [["id", "ASC"]],
      limit: batch,
    });
    if (!rows.length) return total;
    const ids = rows.map((r) => (r as unknown as { id: number }).id);
    const deleted = await model.destroy({
      where: { id: { [Op.in]: ids } } as WhereOptions<Attributes<M>>,
    });
    total += deleted;
    if (rows.length < batch || deleted === 0) return total;
  }
}

/**
 * Delete rows of a table without an id column whose `column` is before `before`, `batch` at a
 * time (MySQL's DELETE … LIMIT), until none are left.
 */
export async function deleteBefore(
  sequelize: Sequelize,
  table: string,
  column: string,
  before: Date,
  batch = 5000,
): Promise<number> {
  let total = 0;
  for (;;) {
    const [res] = await sequelize.query(
      `DELETE FROM \`${table}\` WHERE \`${column}\` < :before LIMIT ${batch}`,
      { replacements: { before } },
    ) as unknown as [{ affectedRows: number }];
    total += res.affectedRows;
    if (res.affectedRows < batch) return total;
  }
}
