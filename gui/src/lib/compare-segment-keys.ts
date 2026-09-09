/** 会议转写段 key 排序——字典序会让 >9 的段号乱序("10"<"2")，
 *  numeric:true 按嵌入数值比较（对齐 usePushToTalk.ts 的既有正确写法）。 */
export function compareSegmentKeys(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true })
}
