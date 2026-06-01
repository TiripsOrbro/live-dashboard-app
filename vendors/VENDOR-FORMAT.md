# Vendor catalog file format

Copy an example from `vendors/examples/` to `vendors/.VendorName` (dotfile, no extension).

## Header comments

```text
# vendor: Schweppes
# location-order: BIBs | Freezes | Bottles | Cans | Other
```

Use `location-order` and a trailing **location** on each line to group stock-count tabs (e.g. Schweppes categories). Americold uses `Freezer | Fridge`.

## Item lines

```text
[buildToDays | manual] | itemCode | name | unit | unit | unit [| location …]
```

| Leading column | Meaning |
|----------------|---------|
| `10`, `7`, `13`, etc. (1–31) | Build-to days: target = ISE average daily usage × days |
| `manual` or `m` | **Manual order** — not auto-filled into MMX vendor orders |
| *(omitted)* | Use built-in rules (7-day salads, 13-day list, default 10-day) |

Unit columns use `N/a` for an unused slot (position is kept for the stock-count UI).

### Examples

```text
10 | 3939 | 7UP BIB 15L | Boxes | N/a | N/a
13 | 39520 | Cooked Beef | Cartons | N/a | Bags | Freezer
manual | 3227 | 7UP 600ml PET | Packs | N/a | Bottles
7 | Lettuce | Crates | Bags | N/a
```

Name-only lines (no item code) are supported for vendors like Cut Fresh.

## Item code cross-reference

Optional `vendors/.item-codes` maps order-form codes to MMX/ISE codes — see `vendors/examples/.item-codes.example`.

## Verify build-to

```bash
npm run build-to-order -- 3811
```

Lines with `buildToSource: catalog-days` use your file; `catalog-manual` items are excluded from auto vendor orders.
