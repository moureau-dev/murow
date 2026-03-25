# generateId

A simple utility function to generate unique 64-bit identifiers using the Web Crypto API.
The IDs are returned as hexadecimal strings and work in both modern browsers and Node.js (v15+).

## Features

- Generates cryptographically strong 64-bit IDs.
- Returns hexadecimal strings (always padded to 16 characters).
- Works in browsers and Node ≥15 without any imports.
- Fast and clean using BigInt arithmetic.

## Usage

```typescript
import { generateId } from './generate-id';
const id = generateId(); // akwats 16-character hex string
```
