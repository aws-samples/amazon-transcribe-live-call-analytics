import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import * as sf from '../structured-fields';

const base32encode = (binary: Uint8Array): string => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let accumulator = 0;
    let result = '';
    binary.forEach(byte => {
        accumulator = (accumulator << 8) | (byte & 0xff);
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            result += alphabet.charAt(accumulator >> bits);
            accumulator = accumulator & ((0x1 << bits) - 1);
        }
    });
    if (bits > 0) {
        result += alphabet.charAt(accumulator << (5 - bits));
    }
    return result.padEnd(Math.floor((result.length + 7) / 8) * 8, '=');
};

type ExpectedValueTyped = {
    '__type': 'token' | 'binary';
    value: string;
};

type ExpectedBareItem = boolean | number | string | ExpectedValueTyped;

type ExpectedParameter = [string, ExpectedBareItem];

type ExpectedParameters = ExpectedParameter[];

type ExpectedItem = [ExpectedBareItem, ExpectedParameters];

type ExpectedInnerList = [ExpectedItem[], ExpectedParameters];

type ExpectedMember = ExpectedItem | ExpectedInnerList;

type ExpectedDictionary = Array<[string, ExpectedMember]>;

type ExpectedListMember = ExpectedItem | ExpectedInnerList;

type ExpectedList = ExpectedListMember[];

type ExpectedTestData = {
    header_type: 'item';
    expected: ExpectedItem;
} | {
    header_type: 'list';
    expected: ExpectedList;
} | {
    header_type: 'dictionary';
    expected: ExpectedDictionary;
};


type ParseTestCase = {
    name: string;
    raw: string[];
    must_fail?: boolean;
    can_fail?: boolean;
    canonical?: string[];
} & ExpectedTestData;

type SerializationTestCase = {
    name: string;
    must_fail?: boolean;
    canonical?: string[];
} & ExpectedTestData;


const hasKey = <T extends object, K extends string>(obj: T, key: K): obj is T & Record<K, unknown> => (key in obj);


const checkExpectedParameters = (expected: ExpectedParameters, params: sf.Parameters): void => {
    if (expected.length !== params.length) {
        throw new Error(`Check failed! Number of parameters mismatch. Expected: ${expected.length}, Actual: ${params.length}`);
    }
    expected.forEach(([key, value], i) => {
        const param = params[i];
        if (key !== param.key) {
            throw new Error(`Check failed! Parameter key mismatch. Expected: '${key}', Actual: '${param.key}'`);
        }
        checkExpectedBareItem(value, param.value);
    });
};

const checkExpectedBareItem = (expected: ExpectedBareItem, item: sf.BareItem): void => {
    if (typeof expected === 'boolean') {
        if (expected !== item) {
            throw new Error(`Check failed! Type: boolean, Expected ${expected}, Actual: ${String(item)}`);
        }
    } else if (typeof expected === 'number') {
        if (expected !== item) {
            throw new Error(`Check failed! Type: number, Expected ${expected}, Actual: ${String(item)}`);
        }
    } else if (typeof expected === 'string') {
        if (expected !== item) {
            throw new Error(`Check failed! Type: string, Expected ${JSON.stringify(expected)}, Actual: ${JSON.stringify(item)}`);
        }
    } else if (typeof expected === 'object') {
        if (expected.__type === 'binary') {
            if (!(item instanceof Uint8Array) || (expected.value !== base32encode(item))) {
                throw new Error(`Check failed! Type: binary, Expected ${expected.value}, Actual: ${(item instanceof Uint8Array) ? base32encode(item) : JSON.stringify(item)}`);
            }
        } else if (expected.__type === 'token') {
            if (Symbol.for(expected.value) !== item) {
                throw new Error(`Check failed! Type: token, Expected ${JSON.stringify(expected.value)}, Actual: ${String(item)}`);
            }
        } else {
            throw new Error(`Check failed! Unexpected expected value: ${JSON.stringify(expected)}`);
        }
    } else {
        throw new Error(`Check failed! Unexpected expected value: ${JSON.stringify(expected)}`);
    }
};

const checkExpectedItem = (expected: ExpectedItem, item: sf.Item): void => {
    checkExpectedBareItem(expected[0], item.value);
    checkExpectedParameters(expected[1], item.params ?? []);
};

const checkExpectedInnerList = ([expValue, expParams]: ExpectedInnerList, { value, params }: sf.InnerList): void => {
    if (expValue.length !== value.length) {
        throw new Error(`Check failed! Number of InnerList elements mismatch. Expected: ${expValue.length}, Actual: ${value.length}`);
    }
    expValue.forEach((expItem, i) => {
        checkExpectedItem(expItem, value[i]);
    });
    checkExpectedParameters(expParams, params ?? []);
};


const checkExpectedItemOrInnerList = ([expValue, expParams]: ExpectedItem | ExpectedInnerList, { value, params }: sf.ListMember): void => {
    if (Array.isArray(expValue)) {
        // BareItem can't be an array, it must be an inner list
        if (!Array.isArray(value) || (value instanceof Uint8Array)) {
            throw new Error('Check failed! expected InnerList, have Item.');
        }
        checkExpectedInnerList([expValue, expParams], { value, params });
    } else {
        if (Array.isArray(value) && !(value instanceof Uint8Array)) {
            throw new Error('Check failed! expected Item, have InnerList.');
        }
        checkExpectedItem([expValue, expParams], { value, params });
    }
};


const checkExpectedList = (expected: ExpectedList, list: sf.List): void => {
    if (expected.length !== list.length) {
        throw new Error(`Check failed! Number of parameters mismatch. Expected: ${expected.length}, Actual: ${list.length}`);
    }
    expected.forEach((element, i) => {
        checkExpectedItemOrInnerList(element, list[i]);
    });
};


const checkExpectedDictionary = (expected: ExpectedDictionary, dict: sf.Dictionary): void => {
    if (expected.length !== dict.size) {
        throw new Error(`Check failed! Number of parameters mismatch. Expected: ${expected.length}, Actual: ${dict.size}`);
    }
    expected.forEach(([expKey, expValue]) => {
        const value = dict.get(expKey);
        if (!value) {
            throw new Error(`Check failed! Expected key '${expKey}' missing`);
        }
        checkExpectedItemOrInnerList(expValue, value);
    });
};


const parseExpectedBareItem = (item: ExpectedBareItem): sf.BareItem => {
    if (typeof item === 'object') {
        if (item.__type === 'binary') {
            throw new Error('Binary serialization test not supported yet');
        } else if (item.__type === 'token') {
            return Symbol.for(item.value);
        } else {
            throw new Error(`Unexpected bare item value: ${JSON.stringify(item)}`);
        }
    } else {
        return item;
    }
};

const parseExpectedParameters = (params: ExpectedParameters): sf.Parameters => (
    params.map(([key, value]) => ({ key, value: parseExpectedBareItem(value) }))
);

const parseExpectedItem = ([bareItem, params]: ExpectedItem): sf.Item => ({
    value: parseExpectedBareItem(bareItem),
    params: parseExpectedParameters(params)
});

const parseExpectedMember = ([itemOrList, expParams]: ExpectedListMember): sf.ListMember | sf.MemberValue => (
    Array.isArray(itemOrList) ? ({
        value: itemOrList.map(parseExpectedItem),
        params: parseExpectedParameters(expParams)
    }) : ({
        value: parseExpectedBareItem(itemOrList),
        params: parseExpectedParameters(expParams)
    })
);

const parseExpectedList = (expected: ExpectedList): sf.List => (
    expected.map(parseExpectedMember)
);

const parseExpectedDictionary = (expected: ExpectedDictionary): sf.Dictionary => (
    new Map<sf.MemberKey, sf.MemberValue>(expected.map(([key, member]) => [key, parseExpectedMember(member)]))
);


const equalCanonical = (actual: string, expected: string): boolean => {
    if (actual === expected) {
        return true;
    }
    // As we don't have a distinct 'decimal' type, the encodeBareItem function 
    // renders numbers without fraction as integer, not decimal.
    // That means we might have '.0' in expected but missing in actual.
    let ia = 0;
    let ie = 0;
    while ((ia < actual.length) && (ie < expected.length)) {
        if (actual[ia] !== expected[ie]) {
            if ((expected[ie] === '.') && (expected[ie + 1] === '0')) {
                ie += 2;
            } else {
                return false;
            }
        }
        ++ia;
        ++ie;
    }
    if (ia !== actual.length) {
        return false;
    } else if (ie === expected.length) {
        return true;
    } else if ((expected.length - ie) !== 2) {
        return false;
    } else {
        return expected.endsWith('.0');
    }
};


const readTestCases = (filepath: string): Array<ParseTestCase | SerializationTestCase> => {
    const data = readFileSync(filepath);
    const json: unknown = JSON.parse(data.toString('utf8'));
    // Quick sanity check (other stuff will fail later if file is bad)
    if (!Array.isArray(json)) {
        throw new Error(`Expect array of test cases. File: ${path.basename(filepath)}`);
    }
    json.forEach((obj, i) => {
        if (typeof obj !== 'object' || obj === null) {
            throw new Error(`Expect object as element [${i}] in file ${path.basename(filepath)}`);
        }
        if (!hasKey(obj, 'name') || (typeof obj.name !== 'string')) {
            throw new Error(`Expect string value property [${i}].name in file ${path.basename(filepath)}`);
        }
        if (!hasKey(obj, 'header_type') || (typeof obj.header_type !== 'string') || !(['item', 'list', 'dictionary'].includes(obj.header_type))) {
            throw new Error(`Expect string value property [${i}].header_type in file ${path.basename(filepath)}`);
        }
    });
    return json as Array<ParseTestCase | SerializationTestCase>;
};



const parseAndRenderAsCanonical = (testCase: ParseTestCase): string => {
    if (testCase.header_type === 'item') {
        const item = sf.parseItemField(testCase.raw);
        checkExpectedItem(testCase.expected, item);
        return sf.encodeItem(item);

    } else if (testCase.header_type === 'list') {
        const list = sf.parseListField(testCase.raw);
        checkExpectedList(testCase.expected, list);
        return sf.encodeList(list);

    } else {
        const dict = sf.parseDictionaryField(testCase.raw);
        checkExpectedDictionary(testCase.expected, dict);
        return sf.encodeDictionary(dict);
    }
};

const serializeToCanonical = (testCase: SerializationTestCase): string => (
    (testCase.header_type === 'item') ? (
        sf.encode(parseExpectedItem(testCase.expected))
    ) : (testCase.header_type === 'list') ? (
        sf.encode(parseExpectedList(testCase.expected))
    ) : (
        sf.encode(parseExpectedDictionary(testCase.expected))
    )
);


declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace jest {
        interface Matchers<R> {
            toMatchCanonical(expected: string): R;
        }
    }
}

expect.extend({
    toMatchCanonical(received: string, expected: string) {
        if (equalCanonical(received, expected)) {
            return {
                message: () =>
                    `expected ${received} not to match ${expected}`,
                pass: true,
            };
        } else {
            return {
                message: () =>
                    `expected ${received} to match ${expected}`,
                pass: false,
            };
        }
    }
});

describe('Testing Structured Field Parsing', () => {

    const basePath = path.resolve('./src/httpsignature/__test__/testdata/structured-field-tests/');

    const dataFiles = (
        ['.', 'serialisation-tests']
            .flatMap((dir) => {
                const base = path.resolve(basePath, dir);
                return readdirSync(base).map(fn => path.resolve(base, fn));
            })
            .filter(p => p.endsWith('.json'))
    );

    dataFiles.forEach((filepath) => {
        describe(path.relative(basePath, filepath), () => {
            const testCases = readTestCases(filepath);

            test.each(testCases)('$name', (item) => {
                if (hasKey(item, 'raw')) {
                    // We're a parse test case
                    expect(item.raw).not.toHaveLength(0);
                    if (item.must_fail) {
                        expect(() => parseAndRenderAsCanonical(item)).toThrow();
                    } else {
                        const canonical = (item.canonical ?? item.raw).join(',');
                        expect(parseAndRenderAsCanonical(item)).toMatchCanonical(canonical);
                    }
                } else {
                    // We're a serialization test case
                    if (item.must_fail) {
                        expect(() => serializeToCanonical(item)).toThrow();
                    } else if (item.canonical) {
                        expect(serializeToCanonical(item)).toMatchCanonical(item.canonical.join(','));
                    } else {
                        expect(() => serializeToCanonical(item)).not.toThrow();
                    }
                }
            });
        });
    });
});
