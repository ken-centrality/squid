import {EvmTopicSet} from '../interfaces/dataHandlers'
import {CallDataRequest, EventDataRequest} from '../interfaces/dataSelection'


type EventReq = {
    name: string
    data?: EventDataRequest
}


type CallReq = {
    name: string
    data?: CallDataRequest
}


type EvmLogReq = {
    contract: string
    filter?: EvmTopicSet[]
    data?: EventDataRequest
}


type EthereumTransactionReq = {
    contract: string
    sighash?: string
    data?: CallDataRequest
}


type ContractsEventReq = {
    contract: string
    data?: EventDataRequest
}


type GearMessageEnqueuedReq = {
    program: string
    data?: EventDataRequest
}


type GearUserMessageSentReq = {
    program: string
    data?: EventDataRequest
}


export interface BatchRequest {
    getIncludeAllBlocks(): boolean
    getEvents(): EventReq[]
    getCalls(): CallReq[]
    getEvmLogs(): EvmLogReq[]
    getEthereumTransactions(): EthereumTransactionReq[]
    getContractsEvents(): ContractsEventReq[]
    getGearMessagesEnqueued(): GearMessageEnqueuedReq[]
    getGearUserMessagesSent(): GearUserMessageSentReq[]
}


export class PlainBatchRequest implements BatchRequest {
    events: EventReq[] = []
    calls: CallReq[] = []
    evmLogs: EvmLogReq[] = []
    ethereumTransactions: EthereumTransactionReq[] = []
    contractsEvents: ContractsEventReq[] = []
    gearMessagesEnqueued: GearMessageEnqueuedReq[] = []
    gearUserMessagesSent: GearUserMessageSentReq[] = []
    includeAllBlocks = false

    getEvents(): EventReq[] {
        return this.events
    }

    getCalls(): CallReq[] {
        return this.calls
    }

    getEvmLogs(): EvmLogReq[] {
        return this.evmLogs
    }

    getEthereumTransactions(): EthereumTransactionReq[] {
        return this.ethereumTransactions
    }

    getContractsEvents(): ContractsEventReq[] {
        return this.contractsEvents
    }

    getGearMessagesEnqueued(): GearMessageEnqueuedReq[] {
        return this.gearMessagesEnqueued
    }

    getGearUserMessagesSent(): GearUserMessageSentReq[] {
        return this.gearUserMessagesSent
    }

    getIncludeAllBlocks(): boolean {
        return this.includeAllBlocks
    }

    merge(other: PlainBatchRequest): PlainBatchRequest {
        let result = new PlainBatchRequest()
        result.includeAllBlocks = this.includeAllBlocks || other.includeAllBlocks
        result.events = this.events.concat(other.events)
        result.calls = this.calls.concat(other.calls)
        result.evmLogs = this.evmLogs.concat(other.evmLogs)
        result.ethereumTransactions = this.ethereumTransactions.concat(other.ethereumTransactions)
        result.contractsEvents = this.contractsEvents.concat(other.contractsEvents)
        result.gearMessagesEnqueued = this.gearMessagesEnqueued.concat(other.gearMessagesEnqueued)
        result.gearUserMessagesSent = this.gearUserMessagesSent.concat(other.gearUserMessagesSent)
        return result
    }
}
