/**
 * A Date as a UTC DATETIME literal for raw-query replacements. Sequelize formats Date replacements
 * in the process's local time zone (not its `timezone` option), which shifts them on hosts that
 * don't run in UTC.
 */
export const sqlDate = (d: Date): string => d.toISOString().slice(0, 23).replace("T", " ");
