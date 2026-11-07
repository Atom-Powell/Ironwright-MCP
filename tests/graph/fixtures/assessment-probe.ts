// Response bodies copied verbatim from the 2026-11-07 probe run 20261107T203924Z,
// docs/superpowers/specs/evidence/2026-11-07-assessment-probe/recordings.jsonl.
// Redaction placeholders are kept: the shape is the fixture, not the values.
export const F0_FOLDER_CREATED = {
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#drives('<drive-id>')/root/children/$entity",
  "@odata.etag": "<etag-1>",
  "eTag": "<etag-1>",
  "lastModifiedDateTime": "2026-11-07T20:39:32Z",
  "createdDateTime": "2026-11-07T20:39:32Z",
  "id": "016TDZ7BBARBQWVVYKNZCZGNNZGPSHHUSG",
  "name": "IW-Probe",
  "size": 0,
  "webUrl": "https://<host>/sites/IronwrightTest/Shared%20Documents/IW-Probe",
  "commentSettings": {
    "commentingDisabled": {
      "isDisabled": false
    }
  },
  "createdBy": {
    "application": {
      "displayName": "Ironwright Repository Reconciliation",
      "id": "<guid>"
    },
    "user": {
      "displayName": "SharePoint App"
    }
  },
  "lastModifiedBy": {
    "application": {
      "displayName": "Ironwright Repository Reconciliation",
      "id": "<guid>"
    },
    "user": {
      "displayName": "SharePoint App"
    }
  },
  "parentReference": {
    "driveId": "<drive-id>",
    "driveType": "documentLibrary",
    "id": "016TDZ7BF6Y2GOVW7725BZO354PWSELRRZ",
    "path": "/drives/<drive-id>/root:",
    "sharepointIds": {
      "listId": "<guid>",
      "listItemUniqueId": "<guid>",
      "siteId": "<guid>",
      "siteUrl": "https://<host>/sites/IronwrightTest",
      "tenantId": "<guid>",
      "webId": "<guid>"
    }
  },
  "fileSystemInfo": {
    "createdDateTime": "2026-11-07T20:39:32Z",
    "lastModifiedDateTime": "2026-11-07T20:39:32Z"
  },
  "folder": {
    "childCount": 0
  },
  "shared": {
    "scope": "unknown"
  }
} as const;
export const F1A_SUBFOLDER_CREATED = {
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#drives('<drive-id>')/root/children/$entity",
  "@odata.etag": "<etag-2>",
  "eTag": "<etag-2>",
  "lastModifiedDateTime": "2026-11-07T20:39:32Z",
  "createdDateTime": "2026-11-07T20:39:32Z",
  "id": "016TDZ7BHMPRXYSOLY3NDJZ6YU6GHZ64D2",
  "name": "probe 20261107T203924Z",
  "size": 0,
  "webUrl": "https://<host>/sites/IronwrightTest/Shared%20Documents/IW-Probe/probe%2020261107T203924Z",
  "commentSettings": {
    "commentingDisabled": {
      "isDisabled": false
    }
  },
  "createdBy": {
    "application": {
      "displayName": "Ironwright Repository Reconciliation",
      "id": "<guid>"
    },
    "user": {
      "displayName": "SharePoint App"
    }
  },
  "lastModifiedBy": {
    "application": {
      "displayName": "Ironwright Repository Reconciliation",
      "id": "<guid>"
    },
    "user": {
      "displayName": "SharePoint App"
    }
  },
  "parentReference": {
    "driveId": "<drive-id>",
    "driveType": "documentLibrary",
    "id": "016TDZ7BBARBQWVVYKNZCZGNNZGPSHHUSG",
    "path": "/drives/<drive-id>/root:/IW-Probe",
    "sharepointIds": {
      "listId": "<guid>",
      "listItemUniqueId": "<guid>",
      "siteId": "<guid>",
      "siteUrl": "https://<host>/sites/IronwrightTest",
      "tenantId": "<guid>",
      "webId": "<guid>"
    }
  },
  "fileSystemInfo": {
    "createdDateTime": "2026-11-07T20:39:32Z",
    "lastModifiedDateTime": "2026-11-07T20:39:32Z"
  },
  "folder": {
    "childCount": 0
  },
  "shared": {
    "scope": "unknown"
  }
} as const;
export const F1B_FOLDER_CONFLICT = {
  "error": {
    "code": "nameAlreadyExists",
    "message": "Name already exists",
    "innerError": {
      "date": "2026-11-07T20:39:32",
      "request-id": "<guid>",
      "client-request-id": "<guid>"
    }
  }
} as const;
export const F2A_FILE_CREATED = {
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#drives('<drive-id>')/root/$entity",
  "@microsoft.graph.downloadUrl": "<download-url>",
  "createdDateTime": "2026-11-07T20:39:33Z",
  "eTag": "<etag-3>",
  "id": "016TDZ7BCIIIOORUNKSZEJFAATGJCPFX6S",
  "lastModifiedDateTime": "2026-11-07T20:39:33Z",
  "name": "dossier.md",
  "webUrl": "https://<host>/sites/IronwrightTest/Shared%20Documents/IW-Probe/probe%2020261107T203924Z/dossier.md",
  "cTag": "\"c:{<guid>},1\"",
  "isAuthoritative": false,
  "size": 8,
  "createdBy": {
    "application": {
      "id": "<guid>",
      "displayName": "Ironwright Repository Reconciliation"
    },
    "user": {
      "displayName": "SharePoint App"
    }
  },
  "lastModifiedBy": {
    "application": {
      "id": "<guid>",
      "displayName": "Ironwright Repository Reconciliation"
    },
    "user": {
      "displayName": "SharePoint App"
    }
  },
  "parentReference": {
    "driveType": "documentLibrary",
    "driveId": "<drive-id>",
    "id": "016TDZ7BHMPRXYSOLY3NDJZ6YU6GHZ64D2",
    "name": "probe 20261107T203924Z",
    "path": "/drives/<drive-id>/root:/IW-Probe/probe 20261107T203924Z",
    "siteId": "<guid>"
  },
  "file": {
    "mimeType": "text/markdown",
    "hashes": {
      "quickXorHash": "IwABHOTwBjGUQQEACAAAAAAAAAA="
    }
  },
  "fileSystemInfo": {
    "createdDateTime": "2026-11-07T20:39:33Z",
    "lastModifiedDateTime": "2026-11-07T20:39:33Z"
  },
  "shared": {
    "scope": "users"
  }
} as const;
export const F2B_FILE_CONFLICT = {
  "error": {
    "code": "nameAlreadyExists",
    "message": "The specified item name already exists.",
    "innerError": {
      "date": "2026-11-07T20:39:33",
      "request-id": "<guid>",
      "client-request-id": "<guid>"
    }
  }
} as const;
export const F3A_FILE_OVERWRITTEN = {
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#drives('<drive-id>')/root/$entity",
  "@microsoft.graph.downloadUrl": "<download-url>",
  "createdDateTime": "2026-11-07T20:39:33Z",
  "eTag": "<etag-4>",
  "id": "016TDZ7BCIIIOORUNKSZEJFAATGJCPFX6S",
  "lastModifiedDateTime": "2026-11-07T20:39:33Z",
  "name": "dossier.md",
  "webUrl": "https://<host>/sites/IronwrightTest/Shared%20Documents/IW-Probe/probe%2020261107T203924Z/dossier.md",
  "cTag": "\"c:{<guid>},2\"",
  "isAuthoritative": false,
  "size": 11,
  "createdBy": {
    "application": {
      "id": "<guid>",
      "displayName": "Ironwright Repository Reconciliation"
    },
    "user": {
      "displayName": "SharePoint App"
    }
  },
  "lastModifiedBy": {
    "application": {
      "id": "<guid>",
      "displayName": "Ironwright Repository Reconciliation"
    },
    "user": {
      "displayName": "SharePoint App"
    }
  },
  "parentReference": {
    "driveType": "documentLibrary",
    "driveId": "<drive-id>",
    "id": "016TDZ7BHMPRXYSOLY3NDJZ6YU6GHZ64D2",
    "name": "probe 20261107T203924Z",
    "path": "/drives/<drive-id>/root:/IW-Probe/probe 20261107T203924Z",
    "siteId": "<guid>"
  },
  "file": {
    "mimeType": "text/markdown",
    "hashes": {
      "quickXorHash": "IwABHOTwBjGUAQR2m4ECAAAAAAA="
    }
  },
  "fileSystemInfo": {
    "createdDateTime": "2026-11-07T20:39:33Z",
    "lastModifiedDateTime": "2026-11-07T20:39:33Z"
  },
  "shared": {
    "scope": "users"
  }
} as const;
export const F3B_STALE_ETAG = {
  "error": {
    "code": "notAllowed",
    "message": "ETag does not match current item's value",
    "innerError": {
      "date": "2026-11-07T20:39:33",
      "request-id": "<guid>",
      "client-request-id": "<guid>"
    }
  }
} as const;
export const F3C_ABSENT_PATH_CREATED = {
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#drives('<drive-id>')/root/$entity",
  "@microsoft.graph.downloadUrl": "<download-url>",
  "createdDateTime": "2026-11-07T20:39:34Z",
  "eTag": "<etag-5>",
  "id": "016TDZ7BDXYWS6VTHOJFBYZOY32TBQNGAM",
  "lastModifiedDateTime": "2026-11-07T20:39:34Z",
  "name": "absent.md",
  "webUrl": "https://<host>/sites/IronwrightTest/Shared%20Documents/IW-Probe/probe%2020261107T203924Z/absent.md",
  "cTag": "\"c:{<guid>},1\"",
  "isAuthoritative": false,
  "size": 16,
  "createdBy": {
    "application": {
      "id": "<guid>",
      "displayName": "Ironwright Repository Reconciliation"
    },
    "user": {
      "displayName": "SharePoint App"
    }
  },
  "lastModifiedBy": {
    "application": {
      "id": "<guid>",
      "displayName": "Ironwright Repository Reconciliation"
    },
    "user": {
      "displayName": "SharePoint App"
    }
  },
  "parentReference": {
    "driveType": "documentLibrary",
    "driveId": "<drive-id>",
    "id": "016TDZ7BHMPRXYSOLY3NDJZ6YU6GHZ64D2",
    "name": "probe 20261107T203924Z",
    "path": "/drives/<drive-id>/root:/IW-Probe/probe 20261107T203924Z",
    "siteId": "<guid>"
  },
  "file": {
    "mimeType": "text/markdown",
    "hashes": {
      "quickXorHash": "YgFBG+owBzqAwA1vsAMI2BAGN5A="
    }
  },
  "fileSystemInfo": {
    "createdDateTime": "2026-11-07T20:39:34Z",
    "lastModifiedDateTime": "2026-11-07T20:39:34Z"
  },
  "shared": {
    "scope": "users"
  }
} as const;
export const L1_ITEMS_PAGE = {
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#sites('<site-id>')/lists('IW%20Probe%20Assessments')/items(fields())",
  "value": [
    {
      "@odata.etag": "\"<guid>,2\"",
      "createdDateTime": "2026-11-07T20:35:33Z",
      "eTag": "\"<guid>,2\"",
      "id": "1",
      "lastModifiedDateTime": "2026-11-07T20:35:33Z",
      "webUrl": "https://<host>/sites/IronwrightTest/Lists/IW%20Probe%20Assessments/1_.000",
      "createdBy": {
        "user": {
          "displayName": "SharePoint App"
        }
      },
      "lastModifiedBy": {
        "application": {
          "id": "<guid>",
          "displayName": "Ironwright Repository Reconciliation"
        },
        "user": {
          "displayName": "SharePoint App"
        }
      },
      "parentReference": {
        "id": "<guid>",
        "siteId": "<site-id>"
      },
      "contentType": {
        "id": "0x0100657241F70677F9448D17D88FB8B09245",
        "name": "Item"
      },
      "fields@odata.context": "https://graph.microsoft.com/v1.0/$metadata#sites('<site-id>')/lists('IW%20Probe%20Assessments')/items('1')/fields/$entity",
      "fields": {
        "@odata.etag": "\"<guid>,2\"",
        "Title": "probe 20261107T203526Z",
        "AssessmentId": "PRB-20261107T203526Z-00001",
        "VendorFolder": "ProbeVendor",
        "Status": "In Progress",
        "id": "1",
        "ContentType": "Item",
        "Modified": "2026-11-07T20:35:33Z",
        "Created": "2026-11-07T20:35:33Z",
        "AuthorLookupId": "1073741822",
        "EditorLookupId": "1073741822",
        "_UIVersionString": "2.0",
        "Attachments": false,
        "Edit": "",
        "LinkTitleNoMenu": "probe 20261107T203526Z",
        "LinkTitle": "probe 20261107T203526Z",
        "ItemChildCount": "0",
        "FolderChildCount": "0",
        "_ComplianceFlags": "",
        "_ComplianceTag": "",
        "_ComplianceTagWrittenTime": "",
        "_ComplianceTagUserId": "",
        "AppAuthorLookupId": "4",
        "AppEditorLookupId": "4"
      }
    }
  ]
} as const;
export const L2A_ITEM_CREATED = {
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#sites('<site-id>')/lists('IW%20Probe%20Assessments')/items/$entity",
  "@odata.etag": "\"<guid>,1\"",
  "createdDateTime": "2026-11-07T20:39:31Z",
  "eTag": "\"<guid>,1\"",
  "id": "2",
  "lastModifiedDateTime": "2026-11-07T20:39:31Z",
  "webUrl": "https://<host>/sites/IronwrightTest/Lists/IW%20Probe%20Assessments/2_.000",
  "createdBy": {
    "user": {
      "displayName": "SharePoint App"
    }
  },
  "lastModifiedBy": {
    "application": {
      "id": "<guid>",
      "displayName": "Ironwright Repository Reconciliation"
    },
    "user": {
      "displayName": "SharePoint App"
    }
  },
  "parentReference": {
    "id": "<guid>",
    "siteId": "<site-id>"
  },
  "contentType": {
    "id": "0x0100657241F70677F9448D17D88FB8B09245",
    "name": "Item"
  },
  "fields@odata.context": "https://graph.microsoft.com/v1.0/$metadata#sites('<site-id>')/lists('IW%20Probe%20Assessments')/items('2')/fields/$entity",
  "fields": {
    "@odata.etag": "\"<guid>,1\"",
    "Title": "probe 20261107T203924Z",
    "VendorFolder": "ProbeVendor",
    "Status": "In Progress",
    "id": "2",
    "ContentType": "Item",
    "Modified": "2026-11-07T20:39:31Z",
    "Created": "2026-11-07T20:39:31Z",
    "AuthorLookupId": "1073741822",
    "EditorLookupId": "1073741822",
    "_UIVersionString": "1.0",
    "Attachments": false,
    "Edit": "",
    "LinkTitleNoMenu": "probe 20261107T203924Z",
    "LinkTitle": "probe 20261107T203924Z",
    "ItemChildCount": "0",
    "FolderChildCount": "0",
    "_ComplianceFlags": "",
    "_ComplianceTag": "",
    "_ComplianceTagWrittenTime": "",
    "_ComplianceTagUserId": "",
    "AppAuthorLookupId": "4",
    "AppEditorLookupId": "4"
  }
} as const;
export const L2B_FIELDS_UPDATED = {
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#sites('<site-id>')/lists('IW%20Probe%20Assessments')/items('2')/fields/$entity",
  "@odata.etag": "\"<guid>,2\"",
  "Title": "probe 20261107T203924Z",
  "AssessmentId": "PRB-20261107T203924Z-00002",
  "VendorFolder": "ProbeVendor",
  "Status": "In Progress",
  "id": "2",
  "ContentType": "Item",
  "Modified": "2026-11-07T20:39:31Z",
  "Created": "2026-11-07T20:39:31Z",
  "AuthorLookupId": "1073741822",
  "EditorLookupId": "1073741822",
  "_UIVersionString": "2.0",
  "Attachments": false,
  "Edit": "",
  "LinkTitleNoMenu": "probe 20261107T203924Z",
  "LinkTitle": "probe 20261107T203924Z",
  "ItemChildCount": "0",
  "FolderChildCount": "0",
  "_ComplianceFlags": "",
  "_ComplianceTag": "",
  "_ComplianceTagWrittenTime": "",
  "_ComplianceTagUserId": "",
  "AppAuthorLookupId": "4",
  "AppEditorLookupId": "4"
} as const;
export const L1B_ITEM_READ = {
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#sites('<site-id>')/lists('IW%20Probe%20Assessments')/items(fields())/$entity",
  "@odata.etag": "\"<guid>,2\"",
  "createdDateTime": "2026-11-07T20:39:31Z",
  "eTag": "\"<guid>,2\"",
  "id": "2",
  "lastModifiedDateTime": "2026-11-07T20:39:31Z",
  "webUrl": "https://<host>/sites/IronwrightTest/Lists/IW%20Probe%20Assessments/2_.000",
  "createdBy": {
    "user": {
      "displayName": "SharePoint App"
    }
  },
  "lastModifiedBy": {
    "application": {
      "id": "<guid>",
      "displayName": "Ironwright Repository Reconciliation"
    },
    "user": {
      "displayName": "SharePoint App"
    }
  },
  "parentReference": {
    "id": "<guid>",
    "siteId": "<site-id>"
  },
  "contentType": {
    "id": "0x0100657241F70677F9448D17D88FB8B09245",
    "name": "Item"
  },
  "fields@odata.context": "https://graph.microsoft.com/v1.0/$metadata#sites('<site-id>')/lists('IW%20Probe%20Assessments')/items('2')/fields/$entity",
  "fields": {
    "@odata.etag": "\"<guid>,2\"",
    "Title": "probe 20261107T203924Z",
    "AssessmentId": "PRB-20261107T203924Z-00002",
    "VendorFolder": "ProbeVendor",
    "Status": "In Progress",
    "id": "2",
    "ContentType": "Item",
    "Modified": "2026-11-07T20:39:31Z",
    "Created": "2026-11-07T20:39:31Z",
    "AuthorLookupId": "1073741822",
    "EditorLookupId": "1073741822",
    "_UIVersionString": "2.0",
    "Attachments": false,
    "Edit": "",
    "LinkTitleNoMenu": "probe 20261107T203924Z",
    "LinkTitle": "probe 20261107T203924Z",
    "ItemChildCount": "0",
    "FolderChildCount": "0",
    "_ComplianceFlags": "",
    "_ComplianceTag": "",
    "_ComplianceTagWrittenTime": "",
    "_ComplianceTagUserId": "",
    "AppAuthorLookupId": "4",
    "AppEditorLookupId": "4"
  }
} as const;
export const L3B_FILTERED_PAGE = {
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#sites('<site-id>')/lists('IW%20Probe%20Assessments')/items(fields())",
  "value": [
    {
      "@odata.etag": "\"<guid>,2\"",
      "createdDateTime": "2026-11-07T20:39:31Z",
      "eTag": "\"<guid>,2\"",
      "id": "2",
      "lastModifiedDateTime": "2026-11-07T20:39:31Z",
      "webUrl": "https://<host>/sites/IronwrightTest/Lists/IW%20Probe%20Assessments/2_.000",
      "createdBy": {
        "user": {
          "displayName": "SharePoint App"
        }
      },
      "lastModifiedBy": {
        "application": {
          "id": "<guid>",
          "displayName": "Ironwright Repository Reconciliation"
        },
        "user": {
          "displayName": "SharePoint App"
        }
      },
      "parentReference": {
        "id": "<guid>",
        "siteId": "<site-id>"
      },
      "contentType": {
        "id": "0x0100657241F70677F9448D17D88FB8B09245",
        "name": "Item"
      },
      "fields@odata.context": "https://graph.microsoft.com/v1.0/$metadata#sites('<site-id>')/lists('IW%20Probe%20Assessments')/items('2')/fields/$entity",
      "fields": {
        "@odata.etag": "\"<guid>,2\"",
        "Title": "probe 20261107T203924Z",
        "AssessmentId": "PRB-20261107T203924Z-00002",
        "VendorFolder": "ProbeVendor",
        "Status": "In Progress",
        "id": "2",
        "ContentType": "Item",
        "Modified": "2026-11-07T20:39:31Z",
        "Created": "2026-11-07T20:39:31Z",
        "AuthorLookupId": "1073741822",
        "EditorLookupId": "1073741822",
        "_UIVersionString": "2.0",
        "Attachments": false,
        "Edit": "",
        "LinkTitleNoMenu": "probe 20261107T203924Z",
        "LinkTitle": "probe 20261107T203924Z",
        "ItemChildCount": "0",
        "FolderChildCount": "0",
        "_ComplianceFlags": "",
        "_ComplianceTag": "",
        "_ComplianceTagWrittenTime": "",
        "_ComplianceTagUserId": "",
        "AppAuthorLookupId": "4",
        "AppEditorLookupId": "4"
      }
    }
  ]
} as const;
