import type { Config } from '@jest/types';

// Sync object
const config: Config.InitialOptions = {
    roots: [
        './src'
    ],
    verbose: true,
    preset: 'ts-jest',
    testEnvironment: 'node',
};
export default config;

// // Or async function
// export default async (): Promise<Config.InitialOptions> => {
//   return {
//     verbose: true,
//   };
// };
