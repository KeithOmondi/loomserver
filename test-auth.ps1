# test-auth.ps1 - Full marketplace API test suite with category attributes
<#
.SYNOPSIS
    Full marketplace API test suite for the e-commerce platform.
.DESCRIPTION
    Tests seller registration, OTP verification, authentication, store creation,
    category management, category tree, and category attributes.
.NOTES
    Requires: PowerShell 7+ and local API running at http://localhost:8000
#>

# ============================================
# Configuration
# ============================================

$BASE_URL     = "http://localhost:8000/api/v1"
$AUTH_URL     = "$BASE_URL/auth"
$STORE_URL    = "$BASE_URL/stores"
$CATEGORY_URL = "$BASE_URL/categories"

# ============================================
# Console colors
# ============================================

$GREEN  = "`e[32m"
$RED    = "`e[31m"
$YELLOW = "`e[33m"
$BLUE   = "`e[34m"
$CYAN   = "`e[36m"
$NC     = "`e[0m"

# ============================================
# Test tracking
# ============================================

$TestsPassed = 0
$TestsFailed = 0

# Captured IDs (used across tests)
$Global:StoreId      = $null
$Global:AccessToken  = $null
$Global:CategoryId   = $null
$Global:CategorySlug = $null

# ============================================
# Helper Functions
# ============================================

function Write-SectionHeader {
    param([string]$Title)
    Write-Host "`n$CYAN----------------------------------------$NC"
    Write-Host "$CYAN $Title$NC"
    Write-Host "$CYAN----------------------------------------$NC"
}

function Test-Result {
    param(
        [string]$Name,
        [bool]$Success
    )
    if ($Success) {
        Write-Host "$GREEN[PASS] $Name$NC"
        $global:TestsPassed++
    } else {
        Write-Host "$RED[FAIL] $Name$NC"
        $global:TestsFailed++
    }
}

function Invoke-Request {
    param(
        [string]$Uri,
        [string]$Method = "Get",
        $Body,
        $Headers = @{},
        [int]$TimeoutSec = 15,
        [switch]$AllowFailure
    )

    try {
        $params = @{
            Uri         = $Uri
            Method      = $Method
            ContentType = "application/json"
            Headers     = $Headers
            TimeoutSec  = $TimeoutSec
            ErrorAction = "Stop"
        }
        if ($Body) { $params.Body = $Body }

        return Invoke-RestMethod @params
    }
    catch {
        # Get the response body for better error messages
        if ($_.Exception.Response) {
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $reader.BaseStream.Position = 0
                $reader.DiscardBufferedData()
                $responseBody = $reader.ReadToEnd()
                Write-Host "$RED   Error: $responseBody$NC"
            } catch {
                Write-Host "$RED   Error: $($_.Exception.Message)$NC"
            }
        } else {
            Write-Host "$RED   Error: $($_.Exception.Message)$NC"
        }

        if ($AllowFailure) { return $null }
        throw
    }
}

function Get-Timestamp {
    return Get-Date -Format 'yyyyMMddHHmmssfff'
}

# ============================================
# Main Execution
# ============================================

Write-Host "$BLUE========================================$NC"
Write-Host "$BLUE    FULL MARKETPLACE TEST SUITE$NC"
Write-Host "$BLUE========================================$NC"

# ============================================
# 1. SELLER REGISTRATION
# ============================================

Write-SectionHeader "1. SELLER REGISTRATION"

$Timestamp   = Get-Timestamp
$SellerEmail = "seller_$Timestamp@example.com"
Write-Host "$YELLOW[INFO] Registering seller: $SellerEmail$NC"

$RegisterBody = @{
    email         = $SellerEmail
    password      = "Test@123456"
    full_name     = "Test Seller"
    phone         = "+254700000000"
    business_name = "Test Store"
    country       = "Kenya"
    business_type = "sole_proprietorship"
    role          = "seller"
} | ConvertTo-Json

try {
    $RegisterResponse = Invoke-Request -Uri "$AUTH_URL/register/seller" -Method Post -Body $RegisterBody
    Test-Result -Name "Seller Registration" -Success $RegisterResponse.success
    if (-not $RegisterResponse.success) { exit 1 }
} catch {
    Test-Result -Name "Seller Registration" -Success $false
    exit 1
}

# ============================================
# 2. VERIFY OTP
# ============================================

Write-SectionHeader "2. VERIFY OTP"
Write-Host "$YELLOW[INFO] Please enter the OTP sent to $SellerEmail$NC"
$OTP = Read-Host "Enter OTP"

$VerifyBody = @{
    email = $SellerEmail
    otp   = $OTP
} | ConvertTo-Json

try {
    $VerifyResponse = Invoke-Request -Uri "$AUTH_URL/verify-otp" -Method Post -Body $VerifyBody
    Test-Result -Name "Verify OTP" -Success $VerifyResponse.success
    if (-not $VerifyResponse.success) { exit 1 }
} catch {
    Test-Result -Name "Verify OTP" -Success $false
    exit 1
}

# ============================================
# 3. LOGIN
# ============================================

Write-SectionHeader "3. LOGIN"

$LoginBody = @{
    email    = $SellerEmail
    password = "Test@123456"
} | ConvertTo-Json

try {
    $LoginResponse = Invoke-Request -Uri "$AUTH_URL/login" -Method Post -Body $LoginBody
    Test-Result -Name "Login" -Success $LoginResponse.success

    if ($LoginResponse.success) {
        $Global:AccessToken = $LoginResponse.accessToken
        Write-Host "$YELLOW   Token: $($Global:AccessToken.Substring(0, 50))...$NC"
    } else {
        exit 1
    }
} catch {
    Test-Result -Name "Login" -Success $false
    exit 1
}

$Headers = @{ "Authorization" = "Bearer $Global:AccessToken" }

# ============================================
# 4. CREATE STORE
# ============================================

Write-SectionHeader "4. CREATE STORE"

$StoreBody = @{
    name                         = "Test Store $Timestamp"
    description                  = "This is a test store"
    location                     = "Nairobi, Kenya"
    contact_email                = "store_$Timestamp@example.com"
    contact_phone                = "+254700000000"
    legal_name                   = "Test Seller Legal"
    date_of_birth                = "1990-01-01"
    government_id_type           = "national_id"
    government_id_number         = "12345678"
    kra_pin                      = "A123456789B"
    bank_name                    = "Test Bank"
    bank_account_name            = "Test Seller"
    bank_account_number          = "1234567890"
    bank_routing_number          = "TESTROUTING"
    mpesa_phone                  = "+254711111111"
    business_type                = "sole_proprietorship"
    business_registration_number = "TESTREG123"
    business_address             = "123 Test Street, Nairobi"
} | ConvertTo-Json

try {
    $StoreResponse = Invoke-Request -Uri "$STORE_URL" -Method Post -Body $StoreBody -Headers $Headers
    Test-Result -Name "Create Store" -Success $StoreResponse.success

    if ($StoreResponse.success) {
        $Global:StoreId = $StoreResponse.data.id
        Write-Host "$YELLOW   Store ID: $Global:StoreId$NC"
        Write-Host "$YELLOW   Store Name: $($StoreResponse.data.name)$NC"
    }
} catch {
    Test-Result -Name "Create Store" -Success $false
}

# ============================================
# 5. GET STORE
# ============================================

Write-SectionHeader "5. GET STORE"

try {
    $GetStoreResponse = Invoke-Request -Uri "$STORE_URL/me" -Method Get -Headers $Headers
    Test-Result -Name "Get Store" -Success $GetStoreResponse.success
} catch {
    Test-Result -Name "Get Store" -Success $false
}

# ============================================
# 6. GET CATEGORIES (Public)
# ============================================

Write-SectionHeader "6. GET CATEGORIES"

try {
    $CategoriesResponse = Invoke-Request -Uri "$CATEGORY_URL" -Method Get
    Test-Result -Name "Get Categories" -Success $CategoriesResponse.success

    if ($CategoriesResponse.success -and $CategoriesResponse.data) {
        Write-Host "$YELLOW   Found $($CategoriesResponse.data.Count) categories$NC"
    }
} catch {
    Test-Result -Name "Get Categories" -Success $false
}

# ============================================
# 7. GET CATEGORY TREE
# ============================================

Write-SectionHeader "7. GET CATEGORY TREE"

try {
    $TreeResponse = Invoke-Request -Uri "$CATEGORY_URL/tree" -Method Get
    Test-Result -Name "Get Category Tree" -Success $TreeResponse.success

    if ($TreeResponse.success) {
        Write-Host "$YELLOW   Root departments: $($TreeResponse.data.Count)$NC"
    }
} catch {
    Test-Result -Name "Get Category Tree" -Success $false
}

# ============================================
# 8. LOOKUP SMARTPHONES CATEGORY
#    (to test the attributes endpoint)
# ============================================

Write-SectionHeader "8. LOOKUP SMARTPHONES CATEGORY"

try {
    $Search = Invoke-Request -Uri "$CATEGORY_URL`?search=Smartphones&limit=5" -Method Get

    if ($Search.success -and $Search.data.Count -gt 0) {
        $Smartphones = $Search.data | Where-Object { $_.slug -eq 'smartphones' } | Select-Object -First 1

        if ($null -ne $Smartphones) {
            $Global:CategoryId   = $Smartphones.id
            $Global:CategorySlug = $Smartphones.slug
            Test-Result -Name "Find Smartphones category" -Success $true
            Write-Host "$YELLOW   Category ID: $Global:CategoryId$NC"
        } else {
            Test-Result -Name "Find Smartphones category" -Success $false
            Write-Host "$RED   'smartphones' slug not found in search results$NC"
        }
    } else {
        Test-Result -Name "Find Smartphones category" -Success $false
    }
} catch {
    Test-Result -Name "Find Smartphones category" -Success $false
}

# ============================================
# 9. GET CATEGORY ATTRIBUTES ⭐ NEW
# ============================================

Write-SectionHeader "9. GET CATEGORY ATTRIBUTES"

if ($Global:CategoryId) {
    try {
        $AttrsResponse = Invoke-Request `
            -Uri "$CATEGORY_URL/$Global:CategoryId/attributes" `
            -Method Get `
            -Headers $Headers

        Test-Result -Name "Get Category Attributes" -Success $AttrsResponse.success

        if ($AttrsResponse.success) {
            $Count = $AttrsResponse.data.attributes.Count
            Write-Host "$YELLOW   Attributes for '$($AttrsResponse.data.category.name)': $Count$NC"

            # Print a compact summary
            foreach ($attr in $AttrsResponse.data.attributes) {
                $optCount = if ($attr.options) { $attr.options.Count } else { 0 }
                $required = if ($attr.is_required) { "REQUIRED" } else { "optional" }
                $unit     = if ($attr.validation.unit) { " ($($attr.validation.unit))" } else { "" }
                Write-Host "     - $($attr.name)$unit [$($attr.type)] $required, $optCount options"
            }

            # Sanity checks
            $HasBrand = $AttrsResponse.data.attributes | Where-Object { $_.slug -eq 'brand' }
            Test-Result -Name "Attributes include 'brand'" -Success ($null -ne $HasBrand)

            $HasRam = $AttrsResponse.data.attributes | Where-Object { $_.slug -eq 'ram_gb' }
            Test-Result -Name "Attributes include 'ram_gb'" -Success ($null -ne $HasRam)
        }
    } catch {
        Test-Result -Name "Get Category Attributes" -Success $false
    }
} else {
    Write-Host "$YELLOW   [SKIP] No CategoryId captured - skipping attribute tests$NC"
}

# ============================================
# 10. GET CATEGORY ATTRIBUTES (invalid UUID) ⭐ NEW
# ============================================

Write-SectionHeader "10. GET CATEGORY ATTRIBUTES - INVALID UUID"

try {
    $BadResponse = Invoke-Request `
        -Uri "$CATEGORY_URL/not-a-uuid/attributes" `
        -Method Get `
        -Headers $Headers `
        -AllowFailure

    # Expect either a 400 (from validator) or a null response
    Test-Result -Name "Invalid UUID is rejected" -Success ($null -eq $BadResponse)
} catch {
    # Throwing is also acceptable - the request should never succeed
    Test-Result -Name "Invalid UUID is rejected" -Success $true
}

# ============================================
# 11. GET CATEGORY ATTRIBUTES (nonexistent UUID) ⭐ NEW
# ============================================

Write-SectionHeader "11. GET CATEGORY ATTRIBUTES - NONEXISTENT CATEGORY"

try {
    $MissingResponse = Invoke-Request `
        -Uri "$CATEGORY_URL/00000000-0000-0000-0000-000000000000/attributes" `
        -Method Get `
        -Headers $Headers `
        -AllowFailure

    Test-Result -Name "Nonexistent category returns no data" -Success ($null -eq $MissingResponse)
} catch {
    Test-Result -Name "Nonexistent category returns no data" -Success $true
}

# ============================================
# 12. LOGOUT
# ============================================

Write-SectionHeader "12. LOGOUT"

try {
    $LogoutResponse = Invoke-Request -Uri "$AUTH_URL/logout" -Method Post -Headers $Headers
    Test-Result -Name "Logout" -Success $LogoutResponse.success
} catch {
    Test-Result -Name "Logout" -Success $false
}

# ============================================
# SUMMARY
# ============================================

Write-Host "`n$BLUE========================================$NC"
Write-Host "$BLUE    TEST SUMMARY$NC"
Write-Host "$BLUE========================================$NC"
Write-Host ""
Write-Host "$GREEN[PASS] Passed: $TestsPassed$NC"
Write-Host "$RED[FAIL] Failed: $TestsFailed$NC"
Write-Host ""
Write-Host "$BLUE----------------------------------------$NC"

if ($TestsFailed -eq 0) {
    Write-Host "$GREEN[SUCCESS] ALL TESTS PASSED!$NC"
    Write-Host "$GREEN[READY] Marketplace API is ready for production!$NC"
} else {
    Write-Host "$RED[ERROR] $TestsFailed test(s) failed. Please review.$NC"
}

Write-Host "$BLUE----------------------------------------$NC`n"