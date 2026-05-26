#!/bin/bash

# ECS Benchmark Runner
# Runs both Murow and Bevy benchmarks 5 times each and averages results

echo "========================================="
echo "  ECS Benchmark Comparison (5 runs each)"
echo "========================================="
echo ""

# Run Raw Murow benchmark 5 times

echo "Running Raw Murow ECS Benchmark (TypeScript/Bun) - 5 runs..."
echo "-----------------------------------------"
for i in {1..5}; do
    echo "Murow run $i/5..."
    bun run ecs/murow/murow.ts 2>/dev/null
done
echo ""

# Run Hybrid Murow benchmark 5 times

echo "Running Hybrid Murow ECS Benchmark (TypeScript/Bun) - 5 runs..."
echo "-----------------------------------------"
for i in {1..5}; do
    echo "Murow run $i/5..."
    bun run ecs/murow/murow-hybrid.ts 2>/dev/null
done
echo ""

# Run Ergonomic Murow benchmark 5 times

echo "Running Ergonomic Murow ECS Benchmark (TypeScript/Bun) - 5 runs..."
echo "-----------------------------------------"
for i in {1..5}; do
    echo "Murow run $i/5..."
    bun run ecs/murow/murow-ergonomic.ts 2>/dev/null
done
echo ""

# Run Fields Murow benchmark 5 times

echo "Running Fields Murow ECS Benchmark (TypeScript/Bun) - 5 runs..."
echo "-----------------------------------------"
for i in {1..5}; do
    echo "Murow run $i/5..."
    bun run ecs/murow/murow-fields.ts 2>/dev/null
done
echo ""

# Run Direct Murow benchmark 5 times

echo "Running Direct Murow ECS Benchmark (TypeScript/Bun) - 5 runs..."
echo "-----------------------------------------"
for i in {1..5}; do
    echo "Murow run $i/5..."
    bun run ecs/murow/murow-direct.ts 2>/dev/null
done
echo ""

# Check if Rust/Cargo is available
if command -v cargo &> /dev/null; then
    echo ""
    echo "Running Bevy ECS Benchmark (Rust) - 5 runs..."
    echo "-----------------------------------------"
    cd ecs/bevy
    for i in {1..5}; do
        echo "Bevy run $i/5..."
        cargo run --release --bin bevy_benchmark 2>/dev/null | grep -v "warning:"
    done
    cd ../..
else
    echo ""
    echo "⚠️  Bevy benchmark skipped (Cargo not found)"
    echo "To run Bevy benchmark, install Rust:"
    echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
fi

echo ""
echo "Running Bitecs Benchmark - 5 runs..."
echo "-----------------------------------------"
for i in {1..5}; do
    echo "Bitecs run $i/5..."
    bun run ecs/bitecs/bitecs.ts 2>/dev/null
done

echo ""
echo "========================================="
echo "  Benchmark Complete"
echo "========================================="
