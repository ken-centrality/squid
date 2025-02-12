import type {QualifiedName, SubstrateBlock, SubstrateEvent, SubstrateExtrinsicSignature} from "./substrate"


export interface BatchRequest {
    limit: number
    fromBlock: number
    toBlock: number
    includeAllBlocks?: boolean
    events?: ObjectRequest[]
    calls?: ObjectRequest[]
    evmLogs?: EvmLogRequest[]
    ethereumTransactions?: EthereumTransactionRequest[]
    contractsEvents?: ContractsEventRequest[]
    gearMessagesEnqueued?: GearMessageEnqueuedRequest[]
    gearUserMessagesSent?: GearUserMessageSentRequest[]
}


export interface ObjectRequest {
    name: string
    data?: any
}


export interface EvmLogRequest {
    contract: string
    filter?: string[][]
    data?: any
}


export interface EthereumTransactionRequest {
    contract: string
    sighash?: string
    data?: any
}


export interface ContractsEventRequest {
    contract: string
    data?: any
}


export interface GearMessageEnqueuedRequest {
    program: string
    data?: any
}


export interface GearUserMessageSentRequest {
    program: string
    data?: any
}


export interface BatchBlock {
    header: Omit<SubstrateBlock, 'timestamp'> & {timestamp: string}
    events: Event[]
    calls: Call[]
    extrinsics: Extrinsic[]
}


export interface Event {
    id: string
    indexInBlock?: number
    name?: QualifiedName
    args?: any
    phase?: SubstrateEvent["phase"]
    extrinsicId?: string
    callId?: string
    pos: number
}


export interface Call {
    id: string
    name?: QualifiedName
    args?: any
    success?: boolean
    extrinsicId?: string
    parentId?: string
    pos: number
}


export interface Extrinsic {
    id: string
    indexInBlock?: number
    callId?: string
    signature?: SubstrateExtrinsicSignature
    fee?: string
    tip?: string
    success?: boolean
    hash?: string
    pos: number
}
