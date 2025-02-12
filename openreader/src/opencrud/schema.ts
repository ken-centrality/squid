import {def, unexpectedCase} from "@subsquid/util-internal"
import {toCamelCase, toPlural} from "@subsquid/util-naming"
import {UserInputError} from "apollo-server-core"
import assert from "assert"
import {
    GraphQLBoolean,
    GraphQLEnumType,
    GraphQLFieldConfig,
    GraphQLFloat,
    GraphQLInputObjectType,
    GraphQLInputType,
    GraphQLInt,
    GraphQLInterfaceType,
    GraphQLList,
    GraphQLNonNull,
    GraphQLObjectType,
    GraphQLOutputType,
    GraphQLResolveInfo,
    GraphQLScalarType,
    GraphQLSchema,
    GraphQLString,
    GraphQLUnionType
} from "graphql"
import {
    GraphQLEnumValueConfigMap,
    GraphQLFieldConfigArgumentMap,
    GraphQLFieldConfigMap,
    GraphQLInputFieldConfigMap
} from "graphql/type/definition"
import {Context} from "../context"
import {decodeRelayConnectionCursor, RelayConnectionRequest} from "../ir/connection"
import {getEntityListSize, getRelaySize, getSize} from '../limit.size'
import {Entity, Interface, JsonObject, Model, Prop} from "../model"
import {getObject, getUnionProps} from "../model.tools"
import {customScalars} from "../scalars"
import {EntityByIdQuery, EntityConnectionQuery, EntityCountQuery, EntityListQuery, Query} from "../sql/query"
import {Subscription} from "../subscription"
import {Limit} from '../util/limit'
import {getResolveTree, getTreeRequest, hasTreeRequest, simplifyResolveTree} from "../util/resolve-tree"
import {ensureArray, identity} from "../util/util"
import {getOrderByMapping, parseOrderBy} from "./orderBy"
import {parseEntityListArguments, parseResolveTree} from "./tree"
import {parseWhere} from "./where"


type GqlFieldMap = GraphQLFieldConfigMap<unknown, Context>


export interface SchemaOptions {
    model: Model
    subscriptions?: boolean
}


export class SchemaBuilder {
    private model: Model
    private types = new Map<string, GraphQLOutputType>()
    private where = new Map<string, GraphQLInputType>()
    private orderBy = new Map<string, GraphQLInputType>()

    constructor(private options: SchemaOptions) {
        this.model = options.model
    }

    private get(name: string): GraphQLOutputType
    private get<T extends GraphQLOutputType>(name: string, kind: Type<T>): T
    private get(name: string, kind?: Type<any>): GraphQLOutputType {
        switch(name) {
            case 'ID':
            case 'String':
                return GraphQLString
            case 'Int':
                return GraphQLInt
            case 'Boolean':
                return GraphQLBoolean
            case 'Float':
                return GraphQLFloat
            case 'DateTime':
                return customScalars.DateTime
            case 'BigInt':
                return customScalars.BigInt
            case 'Bytes':
                return customScalars.Bytes
            case 'JSON':
                return customScalars.JSON
        }

        let type = this.types.get(name)
        if (type == null) {
            type = this.buildType(name)
            this.types.set(name, type)
        }
        if (kind) {
            assert(type instanceof kind)
        }
        return type
    }

    private buildType(name: string): GraphQLOutputType {
        const item = this.model[name]
        switch(item.kind) {
            case "entity":
            case "object":
                return new GraphQLObjectType({
                    name,
                    description: item.description,
                    interfaces: () => item.interfaces?.map(name => this.get(name, GraphQLInterfaceType)),
                    fields: () => this.buildObjectFields(item)
                })
            case "interface":
                return new GraphQLInterfaceType({
                    name,
                    description: item.description,
                    fields: () => this.buildObjectFields(item)
                })
            case "enum":
                return new GraphQLEnumType({
                    name,
                    description: item.description,
                    values: Object.keys(item.values).reduce((values, variant) => {
                        values[variant] = {}
                        return values
                    }, {} as GraphQLEnumValueConfigMap)
                })
            case "union":
                return new GraphQLUnionType({
                    name,
                    description: item.description,
                    types: () => item.variants.map(variant => this.get(variant, GraphQLObjectType)),
                    resolveType(value: any) {
                        return value.isTypeOf
                    }
                })
            default:
                throw unexpectedCase()
        }
    }

    private buildObjectFields(object: Entity | JsonObject | Interface): GraphQLFieldConfigMap<any, any> {
        let fields: GraphQLFieldConfigMap<any, any> = {}
        for (let key in object.properties) {
            let prop = object.properties[key]
            let field: GraphQLFieldConfig<any, any> = {
                description: prop.description,
                type: this.getPropType(prop)
            }
            if (prop.type.kind == 'list-lookup') {
                field.args = this.entityListArguments(prop.type.entity)
            }
            if (object.kind == 'entity' || object.kind == 'object') {
                switch(prop.type.kind) {
                    case 'object':
                    case 'union':
                    case 'fk':
                    case 'lookup':
                    case 'list-lookup':
                        field.resolve = (source, args, context, info) => source[info.path.key]
                        break
                }
            }
            fields[key] = field
        }
        return fields
    }

    private getPropType(prop: Prop): GraphQLOutputType {
        let type: GraphQLOutputType
        switch(prop.type.kind) {
            case "list":
                type = new GraphQLList(this.getPropType(prop.type.item))
                break
            case "fk":
                type = this.get(prop.type.foreignEntity)
                break
            case "lookup":
                return this.get(prop.type.entity)
            case "list-lookup":
                return new GraphQLNonNull(
                    new GraphQLList(
                        new GraphQLNonNull(
                            this.get(prop.type.entity)
                        )
                    )
                )
            default:
                type = this.get(prop.type.name)
        }
        if (!prop.nullable) {
            type = new GraphQLNonNull(type)
        }
        return type
    }

    private entityListArguments(entityName: string): GraphQLFieldConfigArgumentMap {
        return {
            where: {type: this.getWhere(entityName)},
            orderBy: {type: this.getOrderBy(entityName)},
            offset: {type: GraphQLInt},
            limit: {type: GraphQLInt}
        }
    }

    private getWhere(name: string): GraphQLInputType {
        let where = this.where.get(name)
        if (where) return where

        const object = this.model[name]
        switch(object.kind) {
            case "entity":
            case "object":
            case "union":
                break
            default:
                throw unexpectedCase(object.kind)
        }

        where = new GraphQLInputObjectType({
            name: `${name}WhereInput`,
            fields: () => {
                let fields: GraphQLInputFieldConfigMap = {}
                let properties
                if (object.kind == 'union') {
                    properties = getUnionProps(this.model, name).properties
                } else {
                    properties = object.properties
                }

                for (let key in properties) {
                    this.buildPropWhereFilters(key, properties[key], fields)
                }

                if (object.kind == 'entity') {
                    let whereList = new GraphQLList(new GraphQLNonNull(this.getWhere(name)))
                    fields['AND'] = {
                        type: whereList
                    }
                    fields['OR'] = {
                        type: whereList
                    }
                }

                return fields
            }
        })
        this.where.set(name, where)
        return where
    }

    private buildPropWhereFilters(key: string, prop: Prop, fields: GraphQLInputFieldConfigMap): void {
        switch(prop.type.kind) {
            case "scalar":{
                let type = this.get(prop.type.name, GraphQLScalarType)
                let listType = new GraphQLList(new GraphQLNonNull(type))

                fields[`${key}_isNull`] = {type: GraphQLBoolean}
                fields[`${key}_eq`] = {type}
                fields[`${key}_not_eq`] = {type}

                switch(prop.type.name) {
                    case 'ID':
                    case 'String':
                    case 'Int':
                    case 'Float':
                    case 'DateTime':
                    case 'BigInt':
                        fields[`${key}_gt`] = {type}
                        fields[`${key}_gte`] = {type}
                        fields[`${key}_lt`] = {type}
                        fields[`${key}_lte`] = {type}
                        fields[`${key}_in`] = {type: listType}
                        fields[`${key}_not_in`] = {type: listType}
                        break
                    case "JSON":
                        fields[`${key}_jsonContains`] = {type}
                        fields[`${key}_jsonHasKey`] = {type}
                        break
                }

                if (prop.type.name == 'ID' || prop.type.name == 'String') {
                    fields[`${key}_contains`] = {type}
                    fields[`${key}_not_contains`] = {type}
                    fields[`${key}_containsInsensitive`] = {type}
                    fields[`${key}_not_containsInsensitive`] = {type}
                    fields[`${key}_startsWith`] = {type}
                    fields[`${key}_not_startsWith`] = {type}
                    fields[`${key}_endsWith`] = {type}
                    fields[`${key}_not_endsWith`] = {type}
                }

                break
            }
            case "enum": {
                let type = this.get(prop.type.name, GraphQLEnumType)
                let listType = new GraphQLList(new GraphQLNonNull(type))
                fields[`${key}_isNull`] = {type: GraphQLBoolean}
                fields[`${key}_eq`] = {type}
                fields[`${key}_not_eq`] = {type}
                fields[`${key}_in`] = {type: listType}
                fields[`${key}_not_in`] = {type: listType}
                break
            }
            case "list":
                fields[`${key}_isNull`] = {type: GraphQLBoolean}
                if (prop.type.item.type.kind == 'scalar' || prop.type.item.type.kind == 'enum') {
                    let item = this.getPropType(prop.type.item)
                    let list = new GraphQLList(item)
                    fields[`${key}_containsAll`] = {type: list}
                    fields[`${key}_containsAny`] = {type: list}
                    fields[`${key}_containsNone`] = {type: list}
                }
                break
            case "object":
                fields[`${key}_isNull`] = {type: GraphQLBoolean}
                if (this.hasFilters(getObject(this.model, prop.type.name))) {
                    fields[key] = {type: this.getWhere(prop.type.name)}
                }
                break
            case "union":
                fields[`${key}_isNull`] = {type: GraphQLBoolean}
                fields[key] = {type: this.getWhere(prop.type.name)}
                break
            case "fk":
                fields[`${key}_isNull`] = {type: GraphQLBoolean}
                fields[key] = {type: this.getWhere(prop.type.foreignEntity)}
                break
            case "lookup":
                fields[key] = {type: this.getWhere(prop.type.entity)}
                break
            case "list-lookup": {
                let where = this.getWhere(prop.type.entity)
                fields[`${key}_every`] = {type: where}
                fields[`${key}_some`] = {type: where}
                fields[`${key}_none`] = {type: where}
                break
            }
        }
    }

    private hasFilters(obj: JsonObject): boolean {
        for (let key in obj.properties) {
            let propType = obj.properties[key].type
            switch(propType.kind) {
                case 'scalar':
                case 'enum':
                case 'union':
                    return true
                case 'object': {
                    let ref = getObject(this.model, propType.name)
                    if (ref !== obj && this.hasFilters(ref)) {
                        return true
                    }
                }
            }
        }
        return false
    }

    private getOrderBy(entityName: string): GraphQLInputType {
        let orderBy = this.orderBy.get(entityName)
        if (orderBy) return orderBy

        let values: GraphQLEnumValueConfigMap = {}
        for (let variant of getOrderByMapping(this.model, entityName).keys()) {
            values[variant] = {}
        }

        orderBy = new GraphQLList(
            new GraphQLNonNull(
                new GraphQLEnumType({
                    name: `${entityName}OrderByInput`,
                    values
                })
            )
        )
        this.orderBy.set(entityName, orderBy)
        return orderBy
    }

    @def
    build(): GraphQLSchema {
        let query: GqlFieldMap = {}
        let subscription: GqlFieldMap = {}

        for (let name in this.model) {
            let item = this.model[name]
            switch(item.kind) {
                case "entity":
                    this.installEntityList(name, query, subscription)
                    this.installEntityById(name, query, subscription)
                    this.installEntityByUniqueInput(name, query)
                    this.installRelayConnection(name, query)
                    break
            }
        }

        return new GraphQLSchema({
            query: new GraphQLObjectType({
                name: 'Query',
                fields: query
            }),
            subscription: this.options.subscriptions ? new GraphQLObjectType({
                name: "Subscription",
                fields: subscription
            }) : undefined
        })
    }

    private installEntityList(entityName: string, query: GqlFieldMap, subscription: GqlFieldMap): void {
        let model = this.model
        let queryName = toPlural(toCamelCase(entityName))
        let outputType = new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(this.get(entityName))))
        let argsType = this.entityListArguments(entityName)

        function createQuery(context: Context, info: GraphQLResolveInfo, limit?: Limit) {
            let tree = getResolveTree(info)
            let fields = parseResolveTree(model, entityName, info.schema, tree)
            let args = parseEntityListArguments(model, entityName, tree.args)
            limit?.check(() => getEntityListSize(model, entityName, fields, args.limit, args.where) + 1)
            return new EntityListQuery(
                model,
                context.openreader.dialect,
                entityName,
                fields,
                args
            )
        }

        query[queryName] = {
            type: outputType,
            args: argsType,
            resolve(source, args, context, info) {
                let q = createQuery(context, info, context.openreader.responseSizeLimit)
                return context.openreader.executeQuery(q)
            }
        }

        subscription[queryName] = {
            type: outputType,
            args: argsType,
            resolve: identity,
            subscribe(source, args, context, info) {
                let q = createQuery(context, info, context.openreader.subscriptionResponseSizeLimit)
                return context.openreader.subscription(q)
            }
        }
    }

    private installEntityById(entityName: string, query: GqlFieldMap, subscription: GqlFieldMap): void {
        let model = this.model
        let queryName = `${toCamelCase(entityName)}ById`
        let argsType = {
            id: {type: new GraphQLNonNull(GraphQLString)}
        }

        function createQuery(context: Context, info: GraphQLResolveInfo, limit?: Limit) {
            let tree = getResolveTree(info)
            let fields = parseResolveTree(model, entityName, info.schema, tree)
            limit?.check(() => getSize(model, fields) + 1)
            return new EntityByIdQuery(
                model,
                context.openreader.dialect,
                entityName,
                fields,
                tree.args.id as string
            )
        }

        query[queryName] = {
            type: this.get(entityName),
            args: argsType,
            async resolve(source, args, context, info) {
                let q = createQuery(context, info, context.openreader.responseSizeLimit)
                return context.openreader.executeQuery(q)
            }
        }

        subscription[queryName] = {
            type: this.get(entityName),
            args: argsType,
            resolve: identity,
            subscribe(source, args, context, info) {
                let q = createQuery(context, info, context.openreader.subscriptionResponseSizeLimit)
                return context.openreader.subscription(q)
            }
        }
    }

    private installEntityByUniqueInput(entityName: string, query: GqlFieldMap): void {
        let model = this.model

        query[`${toCamelCase(entityName)}ByUniqueInput`] = {
            deprecationReason: `Use ${toCamelCase(entityName)}ById`,
            type: this.get(entityName),
            args: {
                where: {type: this.whereIdInput()}
            },
            async resolve(source, args, context, info) {
                let tree = getResolveTree(info)
                let fields = parseResolveTree(model, entityName, info.schema, tree)
                context.openreader.responseSizeLimit?.check(() => getSize(model, fields) + 1)
                let query = new EntityListQuery(
                    model,
                    context.openreader.dialect,
                    entityName,
                    fields,
                    {where: {op: 'eq', field: 'id', value: args.where.id}}
                )
                let result = await context.openreader.executeQuery(query)
                assert(result.length < 2)
                return result[0]
            }
        }
    }

    private installRelayConnection(entityName: string, query: GqlFieldMap): void {
        let model = this.model
        let outputType = toPlural(entityName) + 'Connection'
        let edgeType = `${entityName}Edge`

        query[`${toPlural(toCamelCase(entityName))}Connection`] = {
            type: new GraphQLNonNull(new GraphQLObjectType({
                name: outputType,
                fields: {
                    edges: {
                        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(new GraphQLObjectType({
                            name: edgeType,
                            fields: {
                                node: {type: new GraphQLNonNull(this.get(entityName))},
                                cursor: {type: new GraphQLNonNull(GraphQLString)}
                            }
                        }))))
                    },
                    pageInfo: {type: this.pageInfoType()},
                    totalCount: {type: new GraphQLNonNull(GraphQLInt)}
                }
            })),
            args: {
                orderBy: {type: new GraphQLNonNull(this.getOrderBy(entityName))},
                after: {type: GraphQLString},
                first: {type: GraphQLInt},
                where: {type: this.getWhere(entityName)}
            },
            async resolve(source, args, context, info) {
                let orderByArg = ensureArray(args.orderBy)
                if (orderByArg.length == 0) {
                    throw new UserInputError('orderBy argument is required for connection')
                }

                let req: RelayConnectionRequest = {
                    orderBy: parseOrderBy(model, entityName, orderByArg),
                    where: parseWhere(args.where)
                }

                if (args.first != null) {
                    if (args.first < 0) {
                        throw new UserInputError("'first' argument of connection can't be less than 0")
                    } else {
                        req.first = args.first
                    }
                }

                if (args.after != null) {
                    if (decodeRelayConnectionCursor(args.after) == null) {
                        throw new UserInputError(`invalid cursor value: ${args.after}`)
                    } else {
                        req.after = args.after
                    }
                }

                let tree = getResolveTree(info, outputType)

                req.totalCount = hasTreeRequest(tree.fields, 'totalCount')
                req.pageInfo = hasTreeRequest(tree.fields, 'pageInfo')

                let edgesTree = getTreeRequest(tree.fields, 'edges')
                if (edgesTree) {
                    let edgeFields = simplifyResolveTree(info.schema, edgesTree, edgeType).fields
                    req.edgeCursor = hasTreeRequest(edgeFields, 'cursor')
                    let nodeTree = getTreeRequest(edgeFields, 'node')
                    if (nodeTree) {
                        req.edgeNode = parseResolveTree(model, entityName, info.schema, nodeTree)
                    }
                }

                context.openreader.responseSizeLimit?.check(() => getRelaySize(model, entityName, req) + 1)

                let result = await context.openreader.executeQuery(new EntityConnectionQuery(
                    model,
                    context.openreader.dialect,
                    entityName,
                    req
                ))

                if (req.totalCount && result.totalCount == null) {
                    result.totalCount = await context.openreader.executeQuery(new EntityCountQuery(
                        model,
                        context.openreader.dialect,
                        entityName,
                        req.where
                    ))
                }

                return result
            }
        }
    }

    @def
    private whereIdInput(): GraphQLInputType {
        return new GraphQLNonNull(
            new GraphQLInputObjectType({
                name: "WhereIdInput",
                fields: {
                    id: {type: new GraphQLNonNull(GraphQLString)}
                }
            })
        )
    }

    @def
    private pageInfoType(): GraphQLOutputType {
        return new GraphQLNonNull(
            new GraphQLObjectType({
                name: "PageInfo",
                fields: {
                    hasNextPage: {type: new GraphQLNonNull(GraphQLBoolean)},
                    hasPreviousPage: {type: new GraphQLNonNull(GraphQLBoolean)},
                    startCursor: {type: new GraphQLNonNull(GraphQLString)},
                    endCursor: {type: new GraphQLNonNull(GraphQLString)}
                }
            })
        )
    }
}


interface Type<T> {
    new (...args: any[]): T
}
