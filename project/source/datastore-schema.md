# Datastore workbook — tab inventory (from .xlsx export, 26 tabs)

## SETTINGS
`dimension ` · rows incl. header: **65** · columns: **5**

`Key` · `Value` · `Description` · `UpdatedAt` · `UpdatedBy`

## CRUX_REGIONS
`dimension ` · rows incl. header: **35** · columns: **7**

`RegionID` · `RegionName` · `Active` · `CreatedAt` · `CreatedBy` · `UpdatedAt` · `UpdatedBy`

## BRANCH_ASSIGNMENTS
`dimension ` · rows incl. header: **100703** · columns: **15**

`AssignmentID` · `PersonEmail` · `AssignmentRole` · `RegionID` · `BranchID` · `ClientID` · `Active` · `EffectiveFrom` · `EffectiveTo` · `Notes` · `CreatedAt` · `CreatedBy` · `UpdatedAt` · `UpdatedBy` · `Dublicate`

## BRANCHES
`dimension ` · rows incl. header: **101331** · columns: **23**

`BranchID` · `ClientID` · `BranchName` · `BranchCode` · `Address` · `CruxPOCName` · `CruxPOCEmpID` · `CruxPOCMobile` · `CruxPOCEmail` · `BranchManagerName` · `BranchManagerMobile` · `BranchManagerEmail` · `LocationHead` · `Location` · `Zone` · `Status` · `EffectiveFrom` · `EffectiveTo` · `Notes` · `CreatedAt` · `UpdatedAt` · `UpdatedBy` · `RegionID`

## Sheet4
`dimension ` · rows incl. header: **12** · columns: **1**

`matrix rows: 3783`

## ATTRIBUTE_POINTS
`dimension ` · rows incl. header: **7** · columns: **12**

`PointID` · `PersonEmail` · `MonthKey` · `Seq` · `Attribute` · `Text` · `SelfRating` · `ManagerRating` · `ManagerNote` · `CreatedAt` · `UpdatedAt` · `UpdatedBy`

## CLIENT_ACTIVATION
`dimension ` · rows incl. header: **636** · columns: **8**

`ActivationID` · `ClientID` · `Location` · `Active` · `ActivatedBy` · `ActivatedAt` · `UpdatedAt` · `UpdatedBy`

## SESSIONS
`dimension ` · rows incl. header: **8** · columns: **9**

`SessionID` · `PersonEmail` · `CreatedAt` · `LastSeenAt` · `ExpiresAt` · `Fingerprint` · `Source` · `RevokedAt` · `RevokedBy`

## KPI_DEFS
`dimension ` · rows incl. header: **20** · columns: **7**

`KpiID` · `PersonEmail` · `Category` · `Position` · `Active` · `UpdatedBy` · `UpdatedAt`

## SCORES
`dimension ` · rows incl. header: **3** · columns: **24**

`ScoreID` · `PersonEmail` · `MonthKey` · `TargetScore` · `AttributeScore` · `FinalScore` · `OwnAttributePoints` · `TeamAttributePoints` · `ManagerRating` · `Comments` · `AreasOfImprovement` · `NextMonthExpectations` · `Status` · `ScoredBy` · `ScoredAt` · `EmployeeDecision` · `DecisionAt` · `DecisionReason` · `HRStatus` · `HRNotes` · `ComputedAt` · `SelfNotes` · `SelfRating` · `SelfSubmittedAt`

## SCORE_LEDGER
`dimension ` · rows incl. header: **1** · columns: **12**

`LedgerID` · `PersonEmail` · `MonthKey` · `Timestamp` · `SourceType` · `SourceID` · `Reason` · `Component` · `Delta` · `ScoreBefore` · `ScoreAfter` · `Sequence`

## PEOPLE_EVENTS
`dimension ` · rows incl. header: **27** · columns: **11**

`EventID` · `Timestamp` · `PersonEmail` · `Type` · `StartDate` · `EndDate` · `Notes` · `IssuedBy` · `Status` · `ClosedAt` · `Outcome`

## Copy of PEOPLE_EVENTS
`dimension ` · rows incl. header: **452** · columns: **11**

`EventID` · `Timestamp` · `PersonEmail` · `Type` · `StartDate` · `EndDate` · `Notes` · `IssuedBy` · `Status` · `ClosedAt` · `Outcome`

## TARGETS
`dimension ` · rows incl. header: **103** · columns: **14**

`TargetID` · `PersonEmail` · `MonthKey` · `TargetValue` · `AchievedValue` · `Notes` · `UpdatedBy` · `UpdatedAt` · `Category` · `ClosedAt` · `ClosedBy` · `ClientID` · `SubCategory` · `Client`

## WARNINGS
`dimension ` · rows incl. header: **1** · columns: **15**

`WarningID` · `IssuedAt` · `EscalationID` · `PersonEmail` · `PersonName` · `ClientID` · `BranchID` · `StrikeLevel` · `Summary` · `FactsJson` · `IssuedBy` · `Status` · `AcknowledgedAt` · `Notes` · `Category`

## DISPATCH_QUEUE
`dimension ` · rows incl. header: **12081** · columns: **12**

`QueueID` · `MonthKey` · `Granularity` · `ClientID` · `BranchID` · `Recipient` · `Status` · `Attempt` · `PlannedAt` · `SentAt` · `Error` · `IdempotencyKey`

## USERS
`dimension ` · rows incl. header: **56** · columns: **26**

`UserID` · `Name` · `Email` · `Mobile` · `Designation` · `Role` · `LocationHead` · `Manager` · `Status` · `CreatedAt` · `UpdatedAt` · `UpdatedBy` · `ScopeZones` · `ScopeLocations` · `ScopeBranchIDs` · `ScopeClientIDs` · `Department` · `EmployeeType` · `PartnerCompany` · `EmployeeID` · `DateOfJoining` · `EmploymentStatus` · `AdminAccess` · `AccessToken` · `InvitedAt` · `InviteStatus`

## CLIENTS
`dimension ` · rows incl. header: **29** · columns: **15**

`ClientID` · `ClientName` · `ClientCode` · `ClientEmail` · `ClientCC` · `DefaultLocationHead` · `Status` · `EffectiveFrom` · `EffectiveTo` · `Notes` · `CreatedAt` · `UpdatedAt` · `UpdatedBy` · `HeadOfficeEmail` · `HeadOfficeCC`

## ESCALATION_MATRIX
`dimension ` · rows incl. header: **3784** · columns: **11**

`MatrixID` · `ClientID` · `Level` · `LevelName` · `ContactName` · `Mobile` · `Email` · `UpdatedAt` · `UpdatedBy` · `BranchID` · `Location`

## HOLIDAYS
`dimension ` · rows incl. header: **1** · columns: **5**

`HolidayID` · `Date` · `Name` · `Status` · `CreatedAt`

## EMAIL_TEMPLATES
`dimension ` · rows incl. header: **6** · columns: **5**

`Key` · `Subject` · `Body` · `UpdatedAt` · `UpdatedBy`

## EMAIL_LOG
`dimension ` · rows incl. header: **2230** · columns: **17**

`LogID` · `Timestamp` · `Type` · `ClientID` · `BranchID` · `ToAddr` · `CcAddr` · `Subject` · `Trigger` · `SentBy` · `Status` · `Attempt` · `Error` · `MessageRef` · `IdempotencyKey` · `RetryBody` · `NextRetryAt`

## REMINDER_LOG
`dimension ` · rows incl. header: **1708** · columns: **7**

`JobKey` · `Type` · `Month` · `ExecutedAt` · `ExecutedBy` · `Result` · `Notes`

## ESCALATIONS
`dimension ` · rows incl. header: **4** · columns: **27**

`EscalationID` · `Type` · `Date` · `Time` · `ClientID` · `BranchID` · `BranchCode` · `ContactName` · `ContactPhone` · `Category` · `Severity` · `EscalatedAgainst` · `Description` · `AssignedOwner` · `RequiredAction` · `TargetDate` · `Status` · `ClosureDate` · `ClosureRemarks` · `CreatedBy` · `CreatedAt` · `UpdatedAt` · `ExceptionBy` · `ExceptionAt` · `ExceptionReason` · `AgainstEmail` · `LastActivityAt`

## ESCALATION_HISTORY
`dimension ` · rows incl. header: **379** · columns: **8**

`HistoryID` · `EscalationID` · `Timestamp` · `User` · `Field` · `OldValue` · `NewValue` · `Note`

## AUDIT_LOG
`dimension ` · rows incl. header: **103276** · columns: **8**

`LogID` · `Timestamp` · `User` · `Action` · `Entity` · `EntityID` · `OldValue` · `NewValue`

