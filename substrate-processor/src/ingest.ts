import {assertNotNull, def, last, unexpectedCase, wait} from "@subsquid/util-internal"
import {Output} from "@subsquid/util-internal-code-printer"
import assert from "assert"
import type {Batch} from "./batch/generic"
import {BatchRequest} from "./batch/request"
import * as gw from "./interfaces/gateway"
import {SubstrateBlock, SubstrateCall, SubstrateEvent, SubstrateExtrinsic} from "./interfaces/substrate"
import {printGqlArguments} from "./util/gql"
import {addErrorContext, withErrorContext} from "./util/misc"
import {Range, rangeEnd} from "./util/range"


export type Item = {
    kind: 'call'
    name: string
    call: SubstrateCall
    extrinsic: SubstrateExtrinsic
} | {
    kind: 'event'
    name: string
    event: SubstrateEvent
}


export interface BlockData {
    header: SubstrateBlock
    items: Item[]
}


export interface DataBatch<R> {
    /**
     * This is roughly the range of scanned blocks
     */
    range: {from: number, to: number}
    request: R
    blocks: BlockData[]
    fetchStartTime: bigint
    fetchEndTime: bigint
}


export interface IngestOptions<R> {
    archiveRequest<T>(query: string): Promise<T>
    archivePollIntervalMS?: number
    batches: Batch<R>[]
    batchSize: number
}


export class Ingest<R extends BatchRequest> {
    private archiveHeight = -1
    private readonly limit: number // maximum number of blocks in a single batch
    private readonly batches: Batch<R>[]
    private readonly maxQueueSize = 3
    private queue: Promise<DataBatch<R>>[] = []
    private fetchLoopIsStopped = true

    constructor(private options: IngestOptions<R>) {
        this.batches = options.batches.slice()
        this.limit = this.options.batchSize
        assert(this.limit > 0)
    }

    @def
    async *getBlocks(): AsyncGenerator<DataBatch<R>> {
        while (this.batches.length) {
            if (this.fetchLoopIsStopped) {
                this.fetchLoop().catch()
            }
            yield await assertNotNull(this.queue[0])
            this.queue.shift()
        }
    }

    private async fetchLoop(): Promise<void> {
        assert(this.fetchLoopIsStopped)
        this.fetchLoopIsStopped = false
        while (this.batches.length && this.queue.length < this.maxQueueSize) {
            let batch = this.batches[0]
            let ctx: {
                batchRange: Range,
                batchBlocksFetched?: number
                archiveHeight?: number
                archiveQuery?: string,
            } = {
                batchRange: batch.range
            }

            let promise = this.waitForHeight(batch.range.from)
                .then(async archiveHeight => {
                    ctx.archiveHeight = archiveHeight
                    ctx.archiveQuery = this.buildBatchQuery(batch, archiveHeight)

                    let fetchStartTime = process.hrtime.bigint()

                    let response: {
                        status: {head: number},
                        batch: gw.BatchBlock[]
                    } = await this.options.archiveRequest(ctx.archiveQuery)

                    let fetchEndTime = process.hrtime.bigint()

                    ctx.batchBlocksFetched = response.batch.length

                    assert(response.status.head >= archiveHeight)
                    this.setArchiveHeight(response)

                    let blocks = response.batch.map(mapGatewayBlock).sort((a, b) => a.header.height - b.header.height)
                    if (blocks.length) {
                        assert(blocks.length <= this.limit)
                        assert(batch.range.from <= blocks[0].header.height)
                        assert(rangeEnd(batch.range) >= last(blocks).header.height)
                        assert(archiveHeight >= last(blocks).header.height)
                    }

                    let from = batch.range.from
                    let to: number
                    if (blocks.length === this.limit && last(blocks).header.height < rangeEnd(batch.range)) {
                        to = last(blocks).header.height
                        this.batches[0] = {
                            range: {from: to + 1, to: batch.range.to},
                            request: batch.request
                        }
                    } else if (archiveHeight < rangeEnd(batch.range)) {
                        to = archiveHeight
                        this.batches[0] = {
                            range: {from: to + 1, to: batch.range.to},
                            request: batch.request
                        }
                    } else {
                        to = assertNotNull(batch.range.to)
                        this.batches.shift()
                    }

                    return {
                        blocks,
                        range: {from, to},
                        request: batch.request,
                        fetchStartTime,
                        fetchEndTime
                    }
                }).catch(withErrorContext(ctx))

            this.queue.push(promise)

            let result = await promise.catch((err: unknown) => {
                assert(err instanceof Error)
                return err
            })

            if (result instanceof Error) {
                return
            }
        }
        this.fetchLoopIsStopped = true
    }

    private buildBatchQuery(batch: Batch<R>, archiveHeight: number): string {
        let from = batch.range.from
        let to = Math.min(archiveHeight, rangeEnd(batch.range))
        assert(from <= to)

        let req = batch.request

        let args: gw.BatchRequest = {
            fromBlock: from,
            toBlock: to,
            limit: this.limit,
            includeAllBlocks: req.getIncludeAllBlocks()
        }

        args.events = req.getEvents().map(({name, data}) => {
            return {
                name,
                data: toGatewayFields(data, CONTEXT_NESTING_SHAPE)
            }
        })

        args.calls = req.getCalls().map(({name, data}) => {
            return {
                name,
                data: toGatewayFields(data, CONTEXT_NESTING_SHAPE)
            }
        })

        args.evmLogs = req.getEvmLogs().map(({contract, filter, data}) => {
            return {
                contract,
                filter: filter?.map(f => f == null ? [] : Array.isArray(f) ? f : [f]),
                data: toGatewayFields(data, CONTEXT_NESTING_SHAPE)
            }
        })

        args.ethereumTransactions = req.getEthereumTransactions().map(({contract, sighash, data}) => {
            return {
                contract,
                sighash,
                data: toGatewayFields(data, CONTEXT_NESTING_SHAPE)
            }
        })

        args.contractsEvents = req.getContractsEvents().map(({contract, data}) => {
            return {
                contract,
                data: toGatewayFields(data, CONTEXT_NESTING_SHAPE)
            }
        })

        args.gearMessagesEnqueued = req.getGearMessagesEnqueued().map(({program, data}) => {
            return {
                program,
                data: toGatewayFields(data, CONTEXT_NESTING_SHAPE)
            }
        })

        args.gearUserMessagesSent = req.getGearUserMessagesSent().map(({program, data}) => {
            return {
                program,
                data: toGatewayFields(data, CONTEXT_NESTING_SHAPE)
            }
        })

        let q = new Output()
        q.block(`query`, () => {
            q.block(`status`, () => {
                q.line('head')
            })
            q.block(`batch(${printGqlArguments(args)})`, () => {
                q.block('header', () => {
                    q.line('id')
                    q.line('height')
                    q.line('hash')
                    q.line('parentHash')
                    q.line('timestamp')
                    q.line('specId')
                    q.line('stateRoot')
                    q.line('extrinsicsRoot')
                })
                q.line('events')
                q.line('calls')
                q.line('extrinsics')
            })
        })
        return q.toString()
    }

    private async waitForHeight(minimumHeight: number): Promise<number> {
        while (this.archiveHeight < minimumHeight) {
            await this.fetchArchiveHeight()
            if (this.archiveHeight >= minimumHeight) {
                return this.archiveHeight
            } else {
                await wait(this.options.archivePollIntervalMS || 5000)
            }
        }
        return this.archiveHeight
    }

    async fetchArchiveHeight(): Promise<number> {
        let res: any = await this.options.archiveRequest('query { status { head } }')
        this.setArchiveHeight(res)
        return this.archiveHeight
    }

    private setArchiveHeight(res: {status: {head: number}}): void {
        let height = res.status.head
        if (height == 0) {
            height = -1
        }
        this.archiveHeight = Math.max(this.archiveHeight, height)
    }

    getLatestKnownArchiveHeight(): number {
        return this.archiveHeight
    }
}


const CONTEXT_NESTING_SHAPE = (() => {
    let call = {
        parent: {}
    }
    let extrinsic = {
        call
    }
    return {
        event: {
            call,
            extrinsic
        },
        call,
        extrinsic
    }
})();


function toGatewayFields(req: any | undefined, shape: Record<string, any> | null): any | undefined {
    if (!req) return undefined
    if (req === true) return shape ? {_all: true} : true
    let fields: any = {}
    for (let key in req) {
        let val = toGatewayFields(req[key], shape?.[key])
        if (val != null) {
            fields[key] = val
        }
    }
    return fields
}


function mapGatewayBlock(block: gw.BatchBlock): BlockData {
    try {
        return tryMapGatewayBlock(block)
    } catch(e: any) {
        throw addErrorContext(e, {
            blockHeight: block.header.height,
            blockHash: block.header.hash
        })
    }
}


function tryMapGatewayBlock(block: gw.BatchBlock): BlockData {
    block.calls = block.calls || []
    block.events = block.events || []
    block.extrinsics = block.extrinsics || []

    let events = createObjects(block.events, go => {
        let {callId, extrinsicId, ...event} = go
        return event
    })

    let calls = createObjects<gw.Call, SubstrateCall>(block.calls, go => {
        let {parentId, extrinsicId, ...call} = go
        return call
    })

    let extrinsics = createObjects<gw.Extrinsic, SubstrateExtrinsic>(block.extrinsics || [], go => {
        let {callId, fee, tip, ...rest} = go
        let extrinsic: Partial<SubstrateExtrinsic> = rest
        if (fee != null) {
            extrinsic.fee = BigInt(fee)
        }
        if (tip != null) {
            extrinsic.tip = BigInt(tip)
        }
        return extrinsic as SubstrateExtrinsic
    })

    let items: Item[] = []

    for (let go of block.events) {
        let event = assertNotNull(events.get(go.id)) as SubstrateEvent
        if (go.extrinsicId) {
            event.extrinsic = assertNotNull(extrinsics.get(go.extrinsicId)) as SubstrateExtrinsic
        }
        if (go.callId) {
            event.call = assertNotNull(calls.get(go.callId)) as SubstrateCall
        }
        items.push({
            kind: 'event',
            name: event.name,
            event
        })
    }

    for (let go of block.calls) {
        let call = assertNotNull(calls.get(go.id)) as SubstrateCall
        if (go.parentId) {
            call.parent = assertNotNull(calls.get(go.parentId)) as SubstrateCall
        }
        let item: Partial<Item> = {
            kind: 'call',
            name: call.name,
            call
        }
        if (go.extrinsicId) {
            item.extrinsic = assertNotNull(extrinsics.get(go.extrinsicId)) as SubstrateExtrinsic
        }
        items.push(item as Item)
    }

    for (let go of block.extrinsics) {
        if (go.callId) {
            let extrinsic = assertNotNull(extrinsics.get(go.id)) as SubstrateExtrinsic
            extrinsic.call = assertNotNull(calls.get(go.id)) as SubstrateCall
        }
    }

    items.sort((a, b) => getPos(a) - getPos(b))

    let {timestamp, ...hdr} = block.header

    return {
        header: {...hdr, timestamp: new Date(timestamp).valueOf()},
        items: items
    }
}


function createObjects<S, T extends {id: string}>(src: S[], f: (s: S) => PartialObj<T>): Map<string, PartialObj<T>> {
    let m = new Map<string, PartialObj<T>>()
    for (let i = 0; i < src.length; i++) {
        let obj = f(src[i])
        m.set(obj.id, obj)
    }
    return m
}


type PartialObj<T> = Partial<T> & {id: string, pos: number}


function getPos(item: Item): number {
    switch(item.kind) {
        case 'call':
            return item.call.pos
        case 'event':
            return item.event.pos
        default:
            throw unexpectedCase()
    }
}
