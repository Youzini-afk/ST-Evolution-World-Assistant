import { z } from 'zod';
import { StoreDefinition } from 'pinia';

// 旧 TavernHelper 全局类型存根 — mvu.ts 是死代码,保留编译兼容
type VariableOption = { type: string; message_id?: number | string; [key: string]: any };
declare function errorCatched<T>(fn: () => T): () => T;
declare function getVariables(option: VariableOption): Record<string, any>;
declare function updateVariablesWith(updater: (vars: any) => void, option: VariableOption): void;

export function defineMvuDataStore<T extends z.ZodObject>(
  schema: T,
  variable_option: VariableOption,
  additional_setup?: (data: Ref<z.infer<T>>) => void,
): StoreDefinition<`mvu_data.${string}`, { data: Ref<z.infer<T>> }> {
  if (
    variable_option.type === 'message' &&
    (variable_option.message_id === undefined || variable_option.message_id === 'latest')
  ) {
    variable_option.message_id = -1;
  }

  return defineStore(
    `mvu_data.${_(variable_option)
      .entries()
      .sortBy(entry => entry[0])
      .map(entry => entry[1])
      .join('.')}`,
    errorCatched(() => {
      const data = ref(
        schema.parse(_.get(getVariables(variable_option), 'stat_data', {}), { reportInput: true }),
      ) as Ref<z.infer<T>>;
      if (additional_setup) {
        additional_setup(data);
      }

      useIntervalFn(() => {
        const stat_data = _.get(getVariables(variable_option), 'stat_data', {});
        const result = schema.safeParse(stat_data);
        if (result.error) {
          return;
        }
        if (!_.isEqual(data.value, result.data)) {
          ignoreUpdates(() => {
            data.value = result.data;
          });
          if (!_.isEqual(stat_data, result.data)) {
            updateVariablesWith(variables => _.set(variables, 'stat_data', result.data), variable_option);
          }
        }
      }, 2000);

      const { ignoreUpdates } = watchIgnorable(
        data,
        new_data => {
          const result = schema.safeParse(new_data);
          if (result.error) {
            return;
          }
          if (!_.isEqual(new_data, result.data)) {
            ignoreUpdates(() => {
              data.value = result.data;
            });
          }
          updateVariablesWith(variables => _.set(variables, 'stat_data', result.data), variable_option);
        },
        { deep: true },
      );

      return { data };
    }),
  );
}
