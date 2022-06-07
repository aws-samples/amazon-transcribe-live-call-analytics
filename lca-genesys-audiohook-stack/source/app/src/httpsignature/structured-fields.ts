/**
 * Types and utility functions to compose and parse structured fields according to RFC8941
 * 
 * @see https://www.rfc-editor.org/rfc/rfc8941.html
 */

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#name-items
 */
export type BareItem = string | number | boolean | symbol | Uint8Array;

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#name-parameters
 */
export type Parameter = {
    key: string;
    value: BareItem;
};

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#name-parameters
 */
export type Parameters = Parameter[];

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#name-items
 */
export type Item = {
    value: BareItem;
    params?: Parameters;
};

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#name-inner-lists
 */
export type InnerList = {
    value: Item[];
    params?: Parameters
};

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#name-lists
 */
export type ListMember = Item | InnerList;

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#name-lists
 */
export type List = ListMember[];

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#name-dictionaries
 */
export type MemberKey = string;

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#name-dictionaries
 */
export type MemberValue = Item | InnerList;

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#name-dictionaries
 */
export type Dictionary = Map<MemberKey, MemberValue>;

export type LiteralDictionary = { [key: MemberKey]: MemberValue };


export const isInnerList = (arg: Item | InnerList): arg is InnerList => (
    Array.isArray(arg.value) && !(arg.value instanceof Uint8Array)
);

export const isItem = (arg: Item | InnerList): arg is Item => (
    !Array.isArray(arg.value) || (arg.value instanceof Uint8Array)
);

export const isString = (arg: BareItem): arg is string => (typeof arg === 'string');

export const isBoolean = (arg: BareItem): arg is boolean => (typeof arg === 'boolean');

export const isNumber = (arg: BareItem): arg is number => (typeof arg === 'number');

export const isInteger = (arg: BareItem): arg is number => Number.isInteger(arg);

export const maybeDecimal = (arg: BareItem): arg is number => (typeof arg === 'number' && !Number.isInteger(arg));

export const isToken = (arg: BareItem): arg is symbol => (typeof arg === 'symbol');

export const isByteSequence = (arg: BareItem): arg is Uint8Array => (arg instanceof Uint8Array);



/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#ser-bare-item
 */
export const encodeBareItem = (item: BareItem): string => {
    if (typeof item === 'string') {
        if (/^[\x20-\x7E]*$/.test(item)) {
            return `"${item.replace(/(["\\])/g, '\\$1')}"`;
        }
        throw new RangeError(`Invalid string value (must be ASCII): ${JSON.stringify(item)}`);

    } else if (typeof item === 'number') {
        // Note: the following condition catches NaN and INF too. Don't "simplify"!
        if (-1e15 < item && item < 1e15) {
            if (Number.isInteger(item)) {
                return item.toFixed(0);
            } else if (-1e12 < item && item < 1e12) {
                const tmp = item.toFixed(3);
                return (
                    tmp.endsWith('00') ? tmp.substring(0, tmp.length - 2) :
                        tmp.endsWith('0') ? tmp.substring(0, tmp.length - 1) :
                            tmp
                );
            }
        }
        throw new RangeError('Invalid numeric value');

    } else if (typeof item === 'boolean') {
        return item ? '?1' : '?0';

    } else if (typeof item === 'symbol') {
        const val = Symbol.keyFor(item);
        if (val && /^[a-zA-Z*][a-zA-Z0-9:/!#$%&'*+\-.^_`|~]*$/.test(val)) {
            return val;
        }
        throw new RangeError(`Invalid symbol/token value: ${JSON.stringify(item)}`);

    } else if (item instanceof Uint8Array) {
        return `:${Buffer.from(item).toString('base64')}:`;

    }
    throw new RangeError(`Invalid/unknown bare item type: '${typeof item}'`);
};

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#ser-key
 */
export const encodeKey = (key: string): string => {
    if (/^[a-z*][a-z0-9_\-.*]*$/.test(key)) {
        return key;
    }
    throw new RangeError(`Invalid key: ${JSON.stringify(key)}`);
};

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#ser-params
 */
export const encodeParameters = (params: Parameters): string => (
    params.reduce(
        (a, { key, value }) => (
            (value === true) ? (
                `${a};${encodeKey(key)}`
            ) : (
                `${a};${encodeKey(key)}=${encodeBareItem(value)}`
            )
        ),
        ''
    )
);

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#name-serializing-an-item
 */
export const encodeItem = (item: Item): string => (
    item.params ? `${encodeBareItem(item.value)}${encodeParameters(item.params)}` : encodeBareItem(item.value)
);

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#name-serializing-a-list
 */
export const encodeList = (list: List): string => (
    list.map(({ value, params }) => (
        (Array.isArray(value) && !(value instanceof Uint8Array)) ? (
            encodeInnerList({ value, params })
        ) : (
            encodeItem({ value, params })
        )
    )).join(', ')
);

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#ser-innerlist
 */
export const encodeInnerList = ({ value, params }: InnerList): string => (
    `(${value.map(encodeItem).join(' ')})${params ? encodeParameters(params) : ''}`
);

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#name-serializing-a-dictionary
 */
export const encodeDictionary = (dict: Dictionary | LiteralDictionary): string => (
    ((dict instanceof Map) ? [...dict.entries()] : Object.entries(dict))
        .map(([key, { value, params }]) => {
            const k = encodeKey(key);
            if (Array.isArray(value) && !(value instanceof Uint8Array)) {
                return `${k}=${encodeInnerList({ value, params })}`;
            } else if (value === true) {
                return params ? `${k}${encodeParameters(params)}` : k;
            } else {
                return `${k}=${encodeItem({ value, params })}`;
            }
        })
        .join(', ')
);

/**
 * @see https://www.rfc-editor.org/rfc/rfc8941.html#name-serializing-structured-fiel
 */
export const encode = (field: BareItem | Item | List | Dictionary): string => {
    if (field instanceof Map) {
        return encodeDictionary(field);
    } else if (field instanceof Uint8Array) {
        return encodeBareItem(field);
    } else if (Array.isArray(field)) {
        return encodeList(field);
    } else if (typeof field === 'object') {
        return encodeItem(field);
    } else {
        return encodeBareItem(field);
    }
};


export type FieldType = 'item' | 'list' | 'dictionary';

export type ParseResult<T> = {
    value: T;
    rest: string;
};

/**
 * Discard optional leading space (SP) characters.
 */
export const discardOsp = (input: string): string => {
    for (let i = 0; i !== input.length; ++i) {
        const ch = input.charCodeAt(i);
        if (ch !== 0x20) {
            return i === 0 ? input : input.substring(i);
        }
    }
    return '';
};

/**
 * Discard optional whitespace (OWS) according to: https://datatracker.ietf.org/doc/html/rfc7230#section-3.2.3
 */
export const discardOws = (input: string): string => {
    for (let i = 0; i !== input.length; ++i) {
        const ch = input.charCodeAt(i);
        if ((ch !== 0x20) && (ch !== 0x09)) {
            return i === 0 ? input : input.substring(i);
        }
    }
    return '';
};

export const expectEndOfField = <T>(result: ParseResult<T>): T => {
    const rest = discardOsp(result.rest);
    if (rest.length !== 0) {
        throw new Error(`Expect end of field: ${JSON.stringify(rest)}`);
    }
    return result.value;
};


// type TypeFromFieldType<T extends FieldType> = (
//     T extends 'dictionary' ? Dictionary :
//     T extends 'list' ? List :
//     T extends 'item' ? Item : unknown
// );

export const parse = (input: string | string[], type: FieldType): Item | List | Dictionary => {
    switch (type) {
        case 'item': return parseItemField(input);
        case 'list': return parseListField(input);
        case 'dictionary': return parseDictionaryField(input);
    }
};

const prepareParserInput = (input: string | string[]): string => (
    discardOsp(Array.isArray(input) ? input.join(',') : input)
);

export const parseListField = (input: string | string[]): List => {
    return expectEndOfField(parseList(prepareParserInput(input)));
};

export const parseDictionaryField = (input: string | string[]): Dictionary => {
    return expectEndOfField(parseDictionary(prepareParserInput(input)));
};

export const parseItemField = (input: string | string[]): Item => {
    // Note: Item type fields with multiple lines almost certainly fail to parse due to the separator comma.
    // However, supporting the array type makes the interface consistent (and it could be a scalar).
    return expectEndOfField(parseItem(prepareParserInput(input)));
};


export const parseList = (input: string): ParseResult<List> => {
    const value: ListMember[] = [];
    let rest = input;
    if (rest.length === 0) {
        return { value, rest };
    }
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const p = parseItemOrInnerList(rest);
        value.push(p.value);
        rest = discardOws(p.rest);
        if (rest.length === 0) {
            return { value, rest };
        }
        if (rest[0] !== ',') {
            throw new RangeError(`Unable to parse List here (expect ','): ${JSON.stringify(rest)}`);
        }
        rest = discardOws(rest.substring(1));
        if (rest.length === 0) {
            throw new RangeError('Expect list element (input ends in \',\')');
        }
    }
};


export const parseItemOrInnerList = (input: string): ParseResult<Item | InnerList> => {
    return (input[0] === '(') ? parseInnerList(input) : parseItem(input);
};


export const parseInnerList = (input: string): ParseResult<InnerList> => {
    if (input[0] !== '(') {
        throw new Error(`Expect Inner List to start with '(': ${JSON.stringify(input)}`);
    }
    let rest = input.substring(1);
    const value: Item[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
        rest = discardOsp(rest);
        if (rest.length === 0) {
            throw new Error('Missing end of Inner List');
        }
        if (rest[0] === ')') {
            const res = parseParameters(rest.substring(1));
            return {
                value: {
                    value,
                    params: res.value
                },
                rest: res.rest
            };
        }
        const item = parseItem(rest);
        value.push(item.value);
        rest = item.rest;
        if ((rest[0] !== ' ') && (rest[0] !== ')')) {
            throw new Error(`Expecting element separator SP or ')' ending Inner List: ${JSON.stringify(rest)}`);
        }
    }
};


export const parseDictionary = (input: string): ParseResult<Dictionary> => {
    const value: Dictionary = new Map();
    let rest = input;
    if (rest.length === 0) {
        return { value, rest };
    }
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const key = parseKey(rest);
        rest = key.rest;
        let member: MemberValue;
        if (rest[0] === '=') {
            const tmp = parseItemOrInnerList(rest.substring(1));
            member = tmp.value;
            rest = tmp.rest;
        } else {
            const tmp = parseParameters(rest);
            member = {
                value: true,
                params: tmp.value
            };
            rest = tmp.rest;
        }
        value.set(key.value, member);
        rest = discardOws(rest);
        if (rest.length === 0) {
            return { value, rest };
        }
        if (rest[0] !== ',') {
            throw new Error(`Expect Dictionary element separator ',': ${JSON.stringify(rest)}`);
        }
        rest = discardOws(rest.substring(1));
        if (rest.length === 0) {
            throw new Error('Expect Dictionary element (input ends in \',\')');
        }
    }
};

export const parseItem = (input: string): ParseResult<Item> => {
    const bare = parseBareItem(input);
    const params = parseParameters(bare.rest);
    return {
        value: {
            value: bare.value,
            params: params.value
        },
        rest: params.rest
    };
};

export const parseBareItem = (input: string): ParseResult<BareItem> => {
    const rest = input;
    if (rest.length === 0) {
        throw new Error('End of input expecting Bare Item');
    }
    const ch = rest.charCodeAt(0);
    if ((ch === 0x2d) || (ch >= 0x30 && ch <= 0x39)) {
        // Looks like a Decimal or integer
        const match = /^-?(\d+)(\.\d*)?/.exec(rest);
        if (!match) {
            throw new Error(`Expecting Integer or Decimal: ${JSON.stringify(rest)}`);
        }
        if (match[2]) {
            if ((match[1].length > 12) || (match[2].length > 4)) {
                throw new Error(`Invalid Decimal value: ${JSON.stringify(rest)}`);
            }
        } else if (match[1].length > 15) {
            throw new Error(`Invalid Integer value: ${JSON.stringify(rest)}`);
        }
        return {
            value: parseFloat(match[0]),
            rest: rest.substring(match[0].length)
        };

    } else if (ch === 0x22) {
        // Looks like a String
        let value = '';
        let i = 1;
        while (i < rest.length) {
            const ch = rest.charCodeAt(i);
            if (ch === 0x5c) {
                ++i;
                if (i === rest.length) {
                    throw new Error('String ends in escape sequence');
                }
                const c = rest[i];
                if (c !== '\\' && c !== '"') {
                    throw new Error(`Invalid escape sequence in String: ${JSON.stringify(rest.substring(i - 1))}`);
                }
                value += c;

            } else if (ch === 0x22) {
                return {
                    value,
                    rest: rest.substring(i + 1)
                };

            } else if ((ch < 0x20) || (ch > 0x7e)) {
                throw new Error(`Invalid character for String type: ${JSON.stringify(rest.substring(i))}`);

            } else {
                value += rest[i];
            }
            ++i;
        }
        throw new Error('Input ends in String');

    } else if (((ch >= 0x41) && (ch <= 0x5a)) || ((ch >= 0x61) && (ch <= 0x7a)) || (ch === 0x2a)) {
        // Looks like a Token
        const match = /^([a-zA-Z*][a-zA-Z0-9:/!#$%&'*+\-.^_`|~]*)/.exec(rest);
        if (!match) {
            throw new Error(`Expecting Token: ${JSON.stringify(rest)}`);
        }
        return {
            value: Symbol.for(match[1]),
            rest: rest.substring(match[0].length)
        };

    } else if (ch === 0x3a) {
        // Looks like binary data
        const match = /^:([a-zA-Z0-9+/]*={0,2}):/.exec(rest);
        if (!match) {
            throw new Error(`Expecting Binary Sequence (base-64): ${JSON.stringify(rest)}`);
        }
        return {
            value: new Uint8Array(Buffer.from(match[1], 'base64')),
            rest: rest.substring(match[0].length)
        };

    } else if (ch === 0x3f) {
        // Looks like a boolean
        if (rest.length < 2) {
            throw new Error(`Input ends in Boolean: ${JSON.stringify(rest)}`);
        }
        let value: boolean;
        if (rest[1] === '0') {
            value = false;
        } else if (rest[1] === '1') {
            value = true;
        } else {
            throw new Error(`Unexpected Boolean input: ${JSON.stringify(rest)}`);
        }
        return {
            value,
            rest: rest.substring(2)
        };

    } else {
        throw new Error(`Expecting Bare Item: ${JSON.stringify(rest)}`);
    }
};

export const parseParameters = (input: string): ParseResult<Parameters> => {
    const value: Parameters = [];
    let rest = input;
    while (rest[0] === ';') {
        rest = discardOsp(rest.substring(1));
        const key = parseKey(rest);
        rest = key.rest;
        let val: BareItem = true;
        if (rest[0] === '=') {
            const tmp = parseBareItem(rest.substring(1));
            val = tmp.value;
            rest = tmp.rest;
        }
        const item = value.find(p => p.key === key.value);
        if (item) {
            item.value = val;
        } else {
            value.push({ key: key.value, value: val });
        }
    }
    return {
        value,
        rest
    };
};

export const parseKey = (input: string): ParseResult<MemberKey> => {
    if (input.length === 0) {
        throw new Error('End of input expecting Key');
    }
    const match = /^([a-z*][a-z0-9_\-.*]*)/.exec(input);
    if (!match) {
        throw new Error(`Unexpected Key: ${JSON.stringify(input)}`);
    }
    return {
        value: match[1],
        rest: input.substring(match[0].length)
    };
};

/*
const hasKey = <T extends object, K extends string>(obj: T, key: K): obj is T & Record<K, unknown> => (key in obj);

export const isBareItem = (arg: unknown): arg is BareItem => {
    const type = typeof arg;
    if((type === 'string') || (type === 'number') || (type === 'boolean') || (type === 'symbol')) {
        return true;
    }
    return arg instanceof Uint8Array;
};

export const isItem = (arg: unknown): arg is Item => (
    (typeof arg === 'object') && (arg !== null) &&
    hasKey(arg, 'value') && isBareItem(arg.value) &&
    (!hasKey(arg, 'params') || isParameters(arg.params))
);

export const isParameter = (arg: unknown): arg is Parameter => (
    (typeof arg === 'object') && (arg !== null) &&
    hasKey(arg, 'key') && (typeof arg.key === 'string') &&
    hasKey(arg, 'value') && isBareItem(arg.value)
);

export const isParameters = (arg: unknown): arg is Parameters => (
    Array.isArray(arg) && arg.every(isParameter)
);

const isItems = (arg: unknown): arg is Item[] => (
    Array.isArray(arg) && arg.every(isBareItem)
);

export const isInnerList = (arg: unknown): arg is Item => (
    (typeof arg === 'object') && (arg !== null) &&
    hasKey(arg, 'value') && isItems(arg.value) &&
    (!hasKey(arg, 'params') || isParameters(arg.params))
);

export const isListMember = (arg: unknown): arg is ListMember => (
    (typeof arg === 'object') && (arg !== null) &&
    hasKey(arg, 'value') && (isItem(arg.value) || isItems(arg.value)) &&
    (!hasKey(arg, 'params') || isParameters(arg.params))
);

export const isMemberValue: (arg: unknown) => arg is MemberValue = isListMember;

export const isList = (arg: unknown): arg is List => (
    Array.isArray(arg) && arg.every(isListMember)
);

export const isDictionary = (arg: unknown): arg is Dictionary => {
    if(arg instanceof Map) {
        for( const [key, value] of arg) {
            if((typeof key !== 'string') || !isMemberValue(value)) {
                return false;
            }
        }
        return true;
    }
    return false;
};
*/

