export type InspectionStatus = '待检查' | '合格' | '不合格' | '待复验'
export type DefectStatus = '待分派' | '整改中' | '待联合复验' | '已关闭' | '带条件通过'
export type Party = '建设单位' | '设备厂家' | '运维单位'

// 证书核验状态由回执对账推导，不再允许手工勾选
export type VerifyState = '已核验' | '待核' | '已撤销' | '已换版'
export type ReceiptState = '有效' | '已撤销' | '已换版'
export type EquipmentStatus = '待验收' | '验收中' | '已验收' | '待核'
export type PlantStatus = '验收中' | '待复核' | '已签署'

export interface AcceptanceItem {
  id: string
  standard: string
  method: string
  condition: string
  status: InspectionStatus
  measured: string
  evidence: string
  version: number
}

export interface Certificate {
  id: string
  name: string
  issuer: string
  expiresAt: string
  version: number
  /** 证书编号（业务编号），可能同一编号挂在多台设备上 */
  certNo: string
  /** 回执编号；老证书可能为空，为空时一律先判待核 */
  receiptNo: string
  /** 已废弃：历史数据的手工勾选结果，状态以回执对账为准 */
  verified?: boolean
}

export interface VerificationReceipt {
  /** 回执编号，登记幂等键 */
  receiptNo: string
  /** 被核验证书的证书编号 */
  certNo: string
  certificateName: string
  issuer: string
  version: number
  state: ReceiptState
  receivedAt: string
  source: string
  batchId: string
}

export interface ReceiptBatch {
  id: string
  source: string
  receivedAt: string
  total: number
  added: number
  duplicated: number
  delivered: number
  /** 传输失败、尚未写入的条目，供“只补没写入的部分”重试 */
  pending: Array<{ receiptNo: string; certNo: string; version: number; state: ReceiptState; certificateName: string; issuer: string }>
  status: '部分写入' | '已完成' | '重复批次'
  note: string
}

export interface EquipmentNode {
  id: string
  parentId: string | null
  name: string
  type: '并网点' | '变压器' | '方阵' | '逆变器' | '汇流箱'
  code: string
  status: EquipmentStatus
  items: AcceptanceItem[]
  certificates: Certificate[]
}

export interface PartyReply {
  party: Party
  owner: string
  content: string
  evidence: string
  repliedAt: string
}

export interface AcceptanceDefect {
  id: string
  equipmentId: string
  itemId: string
  title: string
  severity: '一般' | '重大'
  status: DefectStatus
  owner: string
  dueDate: string
  replies: PartyReply[]
  retests: Array<{ round: number; passed: boolean; result: string; tester: string; testedAt: string }>
  decisionNote: string
  version: number
}

export interface Plant {
  id: string
  name: string
  gridPoint: string
  capacity: string
  commissioningDate: string
  status: PlantStatus
  version: number
}

export interface AuditEntry {
  id: string
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}
