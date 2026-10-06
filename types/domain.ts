export type InspectionStatus = '待检查' | '合格' | '不合格' | '待复验'
export type DefectStatus = '待分派' | '整改中' | '待联合复验' | '已关闭' | '带条件通过'
export type Party = '建设单位' | '设备厂家' | '运维单位'
export type EquipmentStatus = '待验收' | '验收中' | '已验收' | '待核'
export type CertVerifyStatus = '已核验' | '已撤销' | '换版待核' | '版本不符' | '重复挂证' | '缺回执编号' | '待核'

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
  /** 证书编号（签发机构侧的唯一编号），历史老证书可能缺失 */
  certNo: string | null
  name: string
  issuer: string
  expiresAt: string
  version: number
  /** 最近一次比对命中的回执编号，由对账写回，不由人工勾选 */
  receiptNo: string | null
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

/** 回执中的单条证书核验结论 */
export interface ReceiptEntry {
  /** 回执条目号，同一批次内唯一（回执行号） */
  lineNo: string
  certNo: string
  certName: string
  version: number
  result: '有效' | '已撤销' | '换版待核'
  issuer: string
  expiresAt: string
  checkedAt: string
}

/** 外部发来的证书核验回执批次 */
export interface ReceiptBatch {
  receiptNo: string
  issuer: string
  receivedAt: string
  source: string
  entries: ReceiptEntry[]
  /** 已写入（登记）的回执行号集合，用于失败重试只补未写入部分 */
  writtenLines: string[]
  /** 接收过程中失败的行号及原因 */
  failedLines: Array<{ lineNo: string; reason: string }>
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
  status: '验收中' | '待复核' | '已签署'
  version: number
}

/** 台账对账行：一张台账证书对一条最新回执结论 */
export interface CertificateLedgerRow {
  certificateId: string
  equipmentId: string
  equipmentName: string
  certNo: string | null
  certName: string
  ledgerVersion: number
  status: CertVerifyStatus
  receiptNo: string | null
  receiptVersion: number | null
  receiptResult: ReceiptEntry['result'] | null
  checkedAt: string | null
  mountedCount: number
  note: string
}

export interface AuditEntry {
  id: string
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}
