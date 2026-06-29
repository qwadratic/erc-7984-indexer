// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {ERC7984ERC20WrapperMock} from "@openzeppelin/confidential-contracts/mocks/token/ERC7984ERC20WrapperMock.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

/// @title DeployLocal — deploy MockERC20 + ERC7984ERC20WrapperMock on anvil (chainId 31337).
/// @dev Requires the FHEVM host stack (ACL, executor, etc.) to be deployed first
///      via `evm/lib/forge-fhevm/deploy-local.sh`.
contract DeployLocal is Script {
    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        // 1. Deploy underlying ERC-20 mock
        MockERC20 underlying = new MockERC20("Mock WETH", "mWETH");
        console.log("UNDERLYING:", address(underlying));

        // 2. Deploy ERC-7984 wrapper (uses ZamaEthereumConfig → local addresses for chainId 31337)
        ERC7984ERC20WrapperMock wrapper = new ERC7984ERC20WrapperMock(
            IERC20(address(underlying)),
            "Confidential Mock WETH",
            "cmWETH",
            ""
        );
        console.log("TOKEN:", address(wrapper));

        // 3. Mint underlying to deployer for test flows
        underlying.mint(deployer, 1000 ether);
        console.log("DEPLOYER:", deployer);

        vm.stopBroadcast();
    }
}
